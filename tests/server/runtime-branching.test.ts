import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import {
  appendFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import type {
  PiRpcOptions,
  PiRpcProcess,
  PiRpcResponseFence,
} from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import type {
  StageSessionFork,
  StagedSessionFork,
} from "../../server/session-fork.js";
import { SessionProjection } from "../../server/session-projection.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../server/session-catalog.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const FORK_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const directories: string[] = [];
const stores: AttachmentStore[] = [];

const entry = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  content: string,
  timestamp: number,
) => ({
  type: "message",
  id,
  parentId,
  timestamp: new Date(timestamp).toISOString(),
  message: { role, content, timestamp },
});

class BranchRpc extends EventEmitter {
  readonly commands: Array<Record<string, unknown>> = [];
  readonly path: string;
  readonly bridgeCommand: string;
  readonly statusKey: string;
  readonly workerId: string;
  sessionId: string;
  leafId: string | null;
  stops = 0;
  resultMode:
    | "ok"
    | "wrong-nonce"
    | "wrong-worker"
    | "malformed"
    | "duplicate"
    | "cancel"
    | "missing"
    | "persist" = "ok";
  treeDialog = false;
  extensionResponses: Array<Record<string, unknown>> = [];
  private stopped = false;
  private readonly dialogResolvers = new Map<string, () => void>();

  get available(): boolean {
    return !this.stopped;
  }

  constructor(readonly options: PiRpcOptions) {
    super();
    const marker = options.args!.indexOf("--session");
    this.path = resolve(options.args![marker + 1]!);
    this.bridgeCommand = options.env!.INSPIRE_BRANCH_COMMAND!;
    this.statusKey = options.env!.INSPIRE_BRANCH_STATUS_KEY!;
    this.workerId = options.env!.INSPIRE_BRANCH_WORKER_ID!;
    const persisted = readFileSync(this.path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    this.sessionId = String(persisted[0]?.id ?? "");
    const last = [...persisted]
      .reverse()
      .find((candidate) => typeof candidate.id === "string");
    this.leafId = typeof last?.id === "string" ? last.id : null;
  }

  async start() {}

  async stop() {
    this.stops += 1;
    this.stopped = true;
  }

  private waitForDialog(
    id: string,
    method: "confirm" | "input",
  ): Promise<void> {
    this.emit("event", {
      type: "extension_ui_request",
      id,
      method,
      title: `branch ${method}`,
    });
    return new Promise<void>((resolveDialog) =>
      this.dialogResolvers.set(id, resolveDialog),
    );
  }

  private async emitBridge(message: string): Promise<void> {
    const encoded = message.slice(message.indexOf(" ") + 1);
    const request = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const beforeLeaf = this.leafId;
    if (this.treeDialog) await this.waitForDialog("tree-hook", "confirm");
    const cancelled = this.resultMode === "cancel";
    if (!cancelled) this.leafId = String(request.targetId);
    const result = {
      v: 1,
      nonce:
        this.resultMode === "wrong-nonce"
          ? "nonce_wrong_1234567890"
          : request.nonce,
      workerId:
        this.resultMode === "wrong-worker"
          ? "worker_wrong_abcdefghijklmnopqrstuvwxyz"
          : this.workerId,
      sessionId: this.sessionId,
      ok: !cancelled,
      cancelled,
      beforeLeaf,
      effectiveLeaf: this.leafId,
    };
    if (this.resultMode === "persist") {
      await appendFile(
        this.path,
        `${JSON.stringify(entry("unexpected", this.leafId, "assistant", "unexpected write", 60))}\n`,
      );
    }
    if (this.resultMode === "missing") return;
    const event = {
      type: "extension_ui_request",
      id: "internal",
      method: "setStatus",
      statusKey: this.statusKey,
      statusText:
        this.resultMode === "malformed"
          ? "not+base64"
          : Buffer.from(JSON.stringify(result)).toString("base64url"),
    };
    this.emit("event", event);
    if (this.resultMode === "duplicate")
      this.emit("event", { ...event, id: "duplicate" });
  }

  async request<T>(
    command: Record<string, unknown>,
    _timeoutMs?: number,
    _responseFence?: PiRpcResponseFence,
  ): Promise<T> {
    this.commands.push(command);
    let value: unknown = {};
    if (command.type === "get_state") {
      value = {
        sessionId: this.sessionId,
        sessionFile: this.path,
        model: null,
        thinkingLevel: "off",
        isStreaming: false,
        isCompacting: false,
      };
    } else if (command.type === "get_available_models") value = { models: [] };
    else if (command.type === "get_commands")
      value = {
        commands: [
          { name: this.bridgeCommand, source: "extension" },
          { name: "visible", source: "extension" },
        ],
      };
    else if (command.type === "get_entries")
      value = { entries: [], leafId: this.leafId };
    else if (command.type === "prompt") {
      const text = String(command.message ?? "");
      if (text.startsWith(`/${this.bridgeCommand} `))
        await this.emitBridge(text);
      else {
        const persisted = entry("next-user", this.leafId, "user", text, 50);
        await appendFile(this.path, `${JSON.stringify(persisted)}\n`);
        this.leafId = persisted.id;
        this.emit("event", { type: "message_end", message: persisted.message });
      }
    }
    return value as T;
  }

  sendExtensionUiResponse(response: Record<string, unknown>) {
    this.extensionResponses.push(response);
    const id = String(response.id ?? "");
    this.dialogResolvers.get(id)?.();
    this.dialogResolvers.delete(id);
  }
}

function fakeStageFork(directory: string): StageSessionFork {
  return async (request): Promise<StagedSessionFork> => {
    const stagingDir = await mkdtemp(join(directory, ".test-fork-"));
    const stagedPath = join(stagingDir, `${FORK_SESSION_ID}.jsonl`);
    const destinationPath = join(directory, `${FORK_SESSION_ID}.jsonl`);
    const source = (await readFile(request.sourcePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const targetIndex = source.findIndex(
      (candidate) => candidate.id === request.targetId,
    );
    if (targetIndex < 1) throw new Error("Fork fixture target is unavailable");
    const destination = [
      {
        type: "session",
        version: 3,
        id: FORK_SESSION_ID,
        timestamp: "2026-08-01T00:00:00.000Z",
        cwd: directory,
        parentSession: request.sourcePath,
      },
      ...source.slice(1, targetIndex),
    ];
    await writeFile(
      stagedPath,
      `${destination.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    return {
      stagingDir,
      stagedPath,
      destinationPath,
      destinationId: FORK_SESSION_ID,
      cwd: directory,
      parentSessionPath: request.sourcePath,
    };
  };
}

async function setup(
  branchBridgeTimeoutMs = 15_000,
  openForkProjection?: ConstructorParameters<typeof RuntimeController>[5],
  stageFork?: StageSessionFork,
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-branch-runtime-")),
  );
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  const lines = [
    {
      type: "session",
      version: 3,
      id: SESSION_ID,
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: directory,
    },
    entry("u1", null, "user", "root", 1),
    entry("a1", "u1", "assistant", "first answer", 2),
    entry("u2", "a1", "user", "second question", 3),
    entry("a2", "u2", "assistant", "second answer", 4),
  ];
  await writeFile(
    path,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  const record: SessionRecord = {
    id: SESSION_ID,
    cwd: directory,
    path,
    source: null,
    created: new Date(),
    modified: new Date(),
    messageCount: 4,
    firstMessage: "root",
    searchText: "root",
  };
  const records = new Map([[record.id, record]]);
  const catalog: SessionCatalogLike = {
    refresh: async () => [...records.values()],
    get: async (id) => records.get(id),
    list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
    listByIds: async () => [],
    listByCwds: async () => [],
    invalidate() {},
  };
  const attachments = new AttachmentStore(join(directory, "uploads"));
  stores.push(attachments);
  let worker!: BranchRpc;
  const workers: BranchRpc[] = [];
  const runtime = new RuntimeController(
    catalog,
    attachments,
    (options) => {
      worker = new BranchRpc(options);
      workers.push(worker);
      return worker as unknown as PiRpcProcess;
    },
    undefined,
    branchBridgeTimeoutMs,
    openForkProjection,
    undefined,
    undefined,
    undefined,
    stageFork ?? fakeStageFork(directory),
  );
  await runtime.openSession(SESSION_ID);
  await vi.waitFor(() => expect(worker).toBeDefined());
  await vi.waitFor(async () =>
    expect((await runtime.snapshot()).active?.commands).toBeDefined(),
  );
  return { runtime, worker, workers, path, directory, records, catalog };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("stock RPC branch bridge", () => {
  it("keeps normal discovered extensions enabled in production argv while adding the explicit hidden bridge", async () => {
    const { runtime, worker } = await setup();
    try {
      const before = await runtime.snapshot();
      expect(worker.options.args).toContain("--extension");
      expect(worker.options.args).toContain(
        resolve("server/extensions/inspire-branch-bridge.ts"),
      );
      expect(worker.options.args).not.toContain("--no-extensions");
      expect(worker.options.env).toMatchObject({
        INSPIRE_BRANCH_COMMAND: worker.bridgeCommand,
        INSPIRE_BRANCH_STATUS_KEY: worker.statusKey,
        INSPIRE_BRANCH_WORKER_ID: worker.workerId,
      });
      expect(before.active?.commands).toEqual([
        { name: "visible", source: "extension" },
      ]);
      const tree = await runtime.branchTree(SESSION_ID);
      const response = await runtime.navigateBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "a1",
        mode: "switch",
      });
      expect(response.snapshot.active?.effectiveLeafId).toBe("a1");
      expect(response.snapshot.active?.navigationLeased).toBe(true);
      expect(
        JSON.stringify(response.snapshot.active?.transcriptPage.messages),
      ).toContain("first answer");
      expect(
        JSON.stringify(response.snapshot.active?.transcriptPage.messages),
      ).not.toContain("second question");
      expect(
        worker.commands.find((command) => command.type === "get_entries"),
      ).toMatchObject({ since: "a2" });
      await expect(
        runtime.navigateBranch({
          sessionId: SESSION_ID,
          revision: tree.revision,
          targetId: "a2",
          mode: "switch",
        }),
      ).rejects.toThrow(/stale/);

      await runtime.prompt({
        sessionId: SESSION_ID,
        message: "continued branch",
      });
      const committed = await runtime.snapshot();
      expect(committed.active?.effectiveLeafId).toBe("next-user");
      expect(committed.active?.navigationLeased).toBe(false);
      expect(
        JSON.stringify(committed.active?.transcriptPage.messages),
      ).toContain("continued branch");
    } finally {
      await runtime.close();
    }
  });

  it("answers a session_before_tree dialog on the independent response lane without deadlock", async () => {
    const { runtime, worker } = await setup();
    worker.treeDialog = true;
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      const navigating = runtime.navigateBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "a1",
        mode: "switch",
      });
      await vi.waitFor(async () =>
        expect(
          (await runtime.snapshot()).pendingExtensionUiRequests,
        ).toMatchObject([{ id: "tree-hook", sessionId: SESSION_ID }]),
      );
      await runtime.extensionUiResponse({
        sessionId: SESSION_ID,
        id: "tree-hook",
        value: true,
      });
      await expect(navigating).resolves.toMatchObject({
        snapshot: { active: { effectiveLeafId: "a1" } },
      });
      expect(
        worker.extensionResponses.filter(
          (response) => response.id === "tree-hook",
        ),
      ).toHaveLength(1);
      await expect(
        runtime.extensionUiResponse({
          sessionId: SESSION_ID,
          id: "tree-hook",
          value: true,
        }),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await runtime.close();
    }
  });

  it("returns original edit text, navigates to the parent, and refuses the irreducible root case", async () => {
    const { runtime } = await setup();
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      const edited = await runtime.navigateBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "u2",
        mode: "edit",
      });
      expect(edited.editorText).toBe("second question");
      expect(edited.snapshot.active?.effectiveLeafId).toBe("a1");
      await expect(
        runtime.navigateBranch({
          sessionId: SESSION_ID,
          revision: tree.revision,
          targetId: "u1",
          mode: "edit",
        }),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await runtime.close();
    }
  });

  it.each(["wrong-nonce", "wrong-worker", "malformed", "duplicate"] as const)(
    "fails closed for a %s result and stops the ambiguous worker",
    async (mode) => {
      const { runtime, worker } = await setup();
      worker.resultMode = mode;
      const tree = await runtime.branchTree(SESSION_ID);
      await expect(
        runtime.navigateBranch({
          sessionId: SESSION_ID,
          revision: tree.revision,
          targetId: "a1",
          mode: "switch",
        }),
      ).rejects.toMatchObject({ status: 504 });
      expect(worker.stops).toBe(1);
      await runtime.close();
    },
  );

  it("forks through an independent owner while preserving an active source worker, queue, and dialog", async () => {
    const { runtime, worker, workers, path } = await setup();
    try {
      worker.emit("event", { type: "agent_start" });
      worker.emit("event", {
        type: "queue_update",
        steering: ["steer later"],
        followUp: ["follow later"],
      });
      worker.emit("event", {
        type: "extension_ui_request",
        id: "source-dialog",
        method: "confirm",
        title: "Source dialog",
      });
      await vi.waitFor(async () =>
        expect(await runtime.snapshot()).toMatchObject({
          runState: "running",
          pendingExtensionUiRequests: [
            { id: "source-dialog", sessionId: SESSION_ID },
          ],
          pendingQueues: {
            steering: [expect.objectContaining({ textPreview: "steer later" })],
            followUp: [
              expect.objectContaining({ textPreview: "follow later" }),
            ],
          },
        }),
      );
      const sourceBefore = await readFile(path, "utf8");
      const tree = await runtime.branchTree(SESSION_ID);
      const forked = await runtime.forkBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "u2",
      });

      expect(forked).toMatchObject({
        sessionId: FORK_SESSION_ID,
        editorText: "second question",
        snapshot: {
          active: {
            sessionId: FORK_SESSION_ID,
            durableLeafId: "a1",
          },
          sessionStatuses: {
            [SESSION_ID]: { runState: "running" },
          },
        },
      });
      expect(runtime.activeSessionId).toBe(FORK_SESSION_ID);
      expect(worker.commands.some((command) => command.type === "fork")).toBe(
        false,
      );
      expect(worker.stops).toBe(0);
      expect(await readFile(path, "utf8")).toBe(sourceBefore);
      const destination = await readFile(
        join(resolve(path, ".."), `${FORK_SESSION_ID}.jsonl`),
        "utf8",
      );
      expect(destination).toContain('"id":"a1"');
      expect(destination).not.toContain('"id":"u2"');

      const source = await runtime.openSession(SESSION_ID);
      expect(source).toMatchObject({
        active: { sessionId: SESSION_ID },
        runState: "running",
        pendingExtensionUiRequests: [
          { id: "source-dialog", sessionId: SESSION_ID },
        ],
        pendingQueues: {
          steering: [expect.objectContaining({ textPreview: "steer later" })],
          followUp: [expect.objectContaining({ textPreview: "follow later" })],
        },
      });
      expect(workers[0]).toBe(worker);
      expect(worker.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("holds the generated destination reservation across publication and a slower final projection open", async () => {
    let release!: () => void;
    let opened!: () => void;
    let recordsRef!: Map<string, SessionRecord>;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const finalOpen = new Promise<void>((resolveOpen) => {
      opened = resolveOpen;
    });
    const fixture = await setup(15_000, async (record) => {
      if (record.path.includes(`${join("", ".test-fork-")}`)) {
        return SessionProjection.open(record);
      }
      recordsRef.set(record.id, record);
      opened();
      await gate;
      return SessionProjection.open(record);
    });
    const { runtime, workers, records } = fixture;
    recordsRef = records;
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      const forking = runtime.forkBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "u2",
      });
      await finalOpen;
      const openingDestination = runtime.openSession(FORK_SESSION_ID);
      await runtime.openSession(SESSION_ID);
      release();
      const [forked, openedDestination] = await Promise.all([
        forking,
        openingDestination,
      ]);
      expect(forked.sessionId).toBe(FORK_SESSION_ID);
      expect(openedDestination.active?.sessionId).toBe(FORK_SESSION_ID);
      expect(runtime.activeSessionId).toBe(SESSION_ID);
      await vi.waitFor(() =>
        expect(
          workers.filter(
            (candidate) => candidate.sessionId === FORK_SESSION_ID,
          ),
        ).toHaveLength(1),
      );
    } finally {
      release?.();
      await runtime.close();
    }
  });

  it("rejects an atomic destination-path collision without changing the source", async () => {
    const { runtime, worker, directory, path } = await setup();
    const destinationPath = join(directory, `${FORK_SESSION_ID}.jsonl`);
    await writeFile(destinationPath, "existing destination\n");
    const sourceBefore = await readFile(path, "utf8");
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      await expect(
        runtime.forkBranch({
          sessionId: SESSION_ID,
          revision: tree.revision,
          targetId: "u2",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await readFile(destinationPath, "utf8")).toBe(
        "existing destination\n",
      );
      expect(await readFile(path, "utf8")).toBe(sourceBefore);
      expect(worker.stops).toBe(0);
      expect(worker.commands.some((command) => command.type === "fork")).toBe(
        false,
      );
    } finally {
      await runtime.close();
    }
  });

  it("reports a published destination as committed when final attachment fails", async () => {
    let opens = 0;
    const { runtime, worker, directory } = await setup(
      15_000,
      async (record) => {
        opens += 1;
        if (opens === 1) return SessionProjection.open(record);
        throw new Error("projection fixture failed");
      },
    );
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      await expect(
        runtime.forkBranch({
          sessionId: SESSION_ID,
          revision: tree.revision,
          targetId: "u2",
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining(
          `Fork created Session ${FORK_SESSION_ID}`,
        ),
      });
      expect(
        await readFile(join(directory, `${FORK_SESSION_ID}.jsonl`), "utf8"),
      ).toContain('"id":"a1"');
      expect(worker.stops).toBe(0);
      expect((await runtime.snapshot()).runState).not.toBe("conflict");
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when disk changes even if the RPC verification falsely reports no delta", async () => {
    const { runtime, worker } = await setup();
    worker.resultMode = "persist";
    const tree = await runtime.branchTree(SESSION_ID);
    try {
      await expect(
        runtime.navigateBranch({
          sessionId: SESSION_ID,
          revision: tree.revision,
          targetId: "a1",
          mode: "switch",
        }),
      ).rejects.toMatchObject({ status: 504 });
      expect(worker.stops).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("treats cancellation as a truthful refusal without moving or stopping the worker", async () => {
    const { runtime, worker } = await setup();
    worker.resultMode = "cancel";
    const tree = await runtime.branchTree(SESSION_ID);
    try {
      await expect(
        runtime.navigateBranch({
          sessionId: SESSION_ID,
          revision: tree.revision,
          targetId: "a1",
          mode: "switch",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(worker.leafId).toBe("a2");
      expect(worker.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("drops a stale unsolicited internal status without projecting it or poisoning the next operation", async () => {
    const { runtime, worker } = await setup();
    const forwarded: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) =>
      forwarded.push(event as Record<string, unknown>),
    );
    worker.emit("event", {
      type: "extension_ui_request",
      id: "stale",
      method: "setStatus",
      statusKey: worker.statusKey,
      statusText: "not+base64",
    });
    const tree = await runtime.branchTree(SESSION_ID);
    try {
      await runtime.navigateBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "a1",
        mode: "switch",
      });
      expect(forwarded.some((event) => event.id === "stale")).toBe(false);
      expect(
        forwarded.some((event) => event.statusKey === worker.statusKey),
      ).toBe(false);
      expect(worker.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("treats a missing result timeout as outcome-unknown and never retries", async () => {
    const { runtime, worker } = await setup(25);
    worker.resultMode = "missing";
    const tree = await runtime.branchTree(SESSION_ID);
    try {
      await expect(
        runtime.navigateBranch({
          sessionId: SESSION_ID,
          revision: tree.revision,
          targetId: "a1",
          mode: "switch",
        }),
      ).rejects.toMatchObject({ status: 504 });
      expect(worker.stops).toBe(1);
      expect(
        worker.commands.filter((command) => command.type === "prompt"),
      ).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("rejects direct public invocation of the randomized internal command", async () => {
    const { runtime, worker } = await setup();
    try {
      for (const suffix of [" forged", "\tforged", "\nforged", ""]) {
        await expect(
          runtime.prompt({
            sessionId: SESSION_ID,
            message: `/${worker.bridgeCommand}${suffix}`,
          }),
        ).rejects.toMatchObject({ status: 403 });
      }
      expect(
        worker.commands.filter((command) => command.type === "prompt"),
      ).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it("conflicts on external divergence while a navigation lease owns the worker", async () => {
    const { runtime, path } = await setup();
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      await runtime.navigateBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "a1",
        mode: "switch",
      });
      await appendFile(
        path,
        `${JSON.stringify(entry("external", "a2", "assistant", "terminal divergence", 60))}\n`,
      );
      await expect(runtime.branchTree(SESSION_ID)).rejects.toThrow(
        /could not verify ownership/,
      );
      expect((await runtime.snapshot()).runState).toBe("conflict");
    } finally {
      await runtime.close();
    }
  });
});
