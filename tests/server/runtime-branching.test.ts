import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { SessionProjection } from "../../server/session-projection.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../server/session-catalog.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
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
  path: string;
  readonly bridgeCommand: string;
  readonly statusKey: string;
  readonly workerId: string;
  sessionId = SESSION_ID;
  leafId = "a2";
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
  forkPath: string | null = null;
  forkSessionId = "22222222-2222-4222-8222-222222222222";
  forkGate: Promise<void> | null = null;
  forkStarted: (() => void) | null = null;
  forkResponseGate: Promise<void> | null = null;
  forkReplaced: (() => void) | null = null;
  forkDestinationEntry: Record<string, unknown> | null = null;
  forkEventEntry: Record<string, unknown> | null = null;
  nextStateGate: Promise<void> | null = null;
  stateRequestStarted: (() => void) | null = null;
  forkEventCount = 0;
  lateForkEventCount = 0;
  loseWorkerDuringForkExtras = false;
  unavailable = false;
  treeDialog = false;
  forkDialog = false;
  extensionResponses: Array<Record<string, unknown>> = [];

  get available(): boolean {
    return !this.unavailable;
  }

  private readonly dialogResolvers = new Map<string, () => void>();

  emitLateForkEvents(): void {
    for (let index = 0; index < this.lateForkEventCount; index += 1) {
      this.emit("event", { type: "message_update", late: true, index });
    }
  }

  constructor(readonly options: PiRpcOptions) {
    super();
    const marker = options.args!.indexOf("--session");
    this.path = resolve(options.args![marker + 1]!);
    this.bridgeCommand = options.env!.INSPIRE_BRANCH_COMMAND!;
    this.statusKey = options.env!.INSPIRE_BRANCH_STATUS_KEY!;
    this.workerId = options.env!.INSPIRE_BRANCH_WORKER_ID!;
  }

  async start() {}
  async stop() {
    this.stops += 1;
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
    responseFence?: PiRpcResponseFence,
  ): Promise<T> {
    this.commands.push(command);
    let value: unknown = {};
    if (command.type === "get_state") {
      const gate = this.nextStateGate;
      if (gate) {
        this.nextStateGate = null;
        this.stateRequestStarted?.();
        await gate;
      }
      value = {
        sessionId: this.sessionId,
        sessionFile: this.path,
        model: null,
        thinkingLevel: "off",
        isStreaming: false,
        isCompacting: false,
      };
    } else if (command.type === "get_session_stats") {
      if (
        this.loseWorkerDuringForkExtras &&
        this.sessionId === this.forkSessionId
      ) {
        this.unavailable = true;
      }
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
    else if (command.type === "fork") {
      if (!this.forkPath) throw new Error("fork fixture is not configured");
      this.forkStarted?.();
      if (this.forkDialog) await this.waitForDialog("fork-hook", "input");
      if (this.forkGate) await this.forkGate;
      const destination = [
        {
          type: "session",
          version: 3,
          id: this.forkSessionId,
          timestamp: "2026-08-01T00:00:00.000Z",
          cwd: this.options.cwd,
        },
        entry("u1", null, "user", "root", 1),
        entry("a1", "u1", "assistant", "first answer", 2),
        entry("alt", "u1", "assistant", "fork sibling", 5),
        ...(this.forkDestinationEntry ? [this.forkDestinationEntry] : []),
      ];
      await writeFile(
        this.forkPath,
        `${destination.map((line) => JSON.stringify(line)).join("\n")}\n`,
      );
      this.path = this.forkPath;
      this.sessionId = this.forkSessionId;
      this.leafId =
        typeof this.forkDestinationEntry?.id === "string"
          ? this.forkDestinationEntry.id
          : "alt";
      const forkEventEntry = this.forkEventEntry ?? this.forkDestinationEntry;
      if (forkEventEntry)
        this.emit("event", {
          type: "entry_appended",
          entry: forkEventEntry,
        });
      this.forkReplaced?.();
      if (this.forkResponseGate) await this.forkResponseGate;
      if (responseFence) responseFence.received = true;
      for (let index = 0; index < this.forkEventCount; index += 1) {
        this.emit("event", { type: "message_update", index });
      }
      this.emit("event", { type: "session_start", reason: "fork" });
      value = { text: "second question", cancelled: false };
    } else if (command.type === "prompt") {
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

async function setup(
  branchBridgeTimeoutMs = 15_000,
  openForkProjection?: ConstructorParameters<typeof RuntimeController>[5],
) {
  const directory = await mkdtemp(join(tmpdir(), "inspire-branch-runtime-"));
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

  it("emits a session_before_fork dialog under the source id and rebinds only unresolved requests", async () => {
    const { runtime, worker, directory } = await setup();
    worker.forkPath = join(directory, "forked-dialog.jsonl");
    worker.forkDialog = true;
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) =>
      events.push(event as Record<string, unknown>),
    );
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      const forking = runtime.forkBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "u2",
      });
      await vi.waitFor(() =>
        expect(events.find((event) => event.id === "fork-hook")).toMatchObject({
          sessionId: SESSION_ID,
        }),
      );
      await runtime.extensionUiResponse({
        sessionId: SESSION_ID,
        id: "fork-hook",
        value: "continue",
      });
      const result = await forking;
      expect(result.sessionId).toBe(worker.forkSessionId);
      expect(result.snapshot.pendingExtensionUiRequests).toEqual([]);
      expect(
        worker.extensionResponses.filter(
          (response) => response.id === "fork-hook",
        ),
      ).toHaveLength(1);
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

  it("buffers fork replacement events, atomically rebinds identity, and keeps the bridge usable", async () => {
    const { runtime, worker, directory } = await setup();
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) =>
      events.push(event as Record<string, unknown>),
    );
    worker.forkPath = join(directory, "forked.jsonl");
    try {
      const sourceTree = await runtime.branchTree(SESSION_ID);
      const forked = await runtime.forkBranch({
        sessionId: SESSION_ID,
        revision: sourceTree.revision,
        targetId: "u2",
      });
      expect(forked.sessionId).toBe(worker.forkSessionId);
      expect(forked.editorText).toBe("second question");
      expect(runtime.activeSessionId).toBe(worker.forkSessionId);
      expect(forked.snapshot.active?.sessionId).toBe(worker.forkSessionId);
      expect(
        events.find((event) => event.type === "session_start"),
      ).toMatchObject({ sessionId: worker.forkSessionId });
      expect(
        events.some(
          (event) =>
            event.sessionId === SESSION_ID && event.type === "session_start",
        ),
      ).toBe(false);
      const slots = (
        runtime as unknown as { slots: Map<string, { projection: unknown }> }
      ).slots;
      await vi.waitFor(() => expect(slots.has(SESSION_ID)).toBe(false));
      expect(
        [...slots.values()].filter((slot) => slot.projection !== null),
      ).toHaveLength(1);

      const destinationTree = await runtime.branchTree(worker.forkSessionId);
      const navigated = await runtime.navigateBranch({
        sessionId: worker.forkSessionId,
        revision: destinationTree.revision,
        targetId: "a1",
        mode: "switch",
      });
      expect(navigated.snapshot.active?.effectiveLeafId).toBe("a1");
      expect(worker.stops).toBe(0);

      const reopened = await runtime.openSession(SESSION_ID);
      expect(reopened.active?.sessionId).toBe(SESSION_ID);
      await vi.waitFor(() => expect(slots.has(SESSION_ID)).toBe(true));
    } finally {
      await runtime.close();
    }
  });

  it("rejects a fork destination already reserved by an in-flight projection load", async () => {
    const { runtime, worker, directory } = await setup();
    worker.forkPath = join(directory, "forked-loading-collision.jsonl");
    const loadingPaths = (
      runtime as unknown as {
        loadingPaths: Map<string, Promise<unknown>>;
      }
    ).loadingPaths;
    loadingPaths.set(resolve(worker.forkPath), Promise.resolve({}));
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      await expect(
        runtime.forkBranch({
          sessionId: SESSION_ID,
          revision: tree.revision,
          targetId: "u2",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(worker.stops).toBeGreaterThan(0);
    } finally {
      loadingPaths.delete(resolve(worker.forkPath));
      await runtime.close();
    }
  });

  it("keeps source snapshot identity stable while a concurrent read straddles fork replacement", async () => {
    const { runtime, worker, workers, directory, path } = await setup();
    worker.forkPath = join(directory, "forked-concurrent-snapshot.jsonl");
    worker.forkDestinationEntry = {
      type: "custom",
      id: "destination-state",
      parentId: "alt",
      timestamp: "2026-08-01T00:00:00.006Z",
      customType: "fork-state",
      data: { active: true },
    };
    let releaseState!: () => void;
    let releaseFork!: () => void;
    const stateRequested = new Promise<void>((resolveState) => {
      worker.stateRequestStarted = resolveState;
    });
    worker.nextStateGate = new Promise<void>((resolveState) => {
      releaseState = resolveState;
    });
    const forkReplaced = new Promise<void>((resolveFork) => {
      worker.forkReplaced = resolveFork;
    });
    worker.forkResponseGate = new Promise<void>((resolveFork) => {
      releaseFork = resolveFork;
    });
    try {
      const sourceTree = await runtime.branchTree(SESSION_ID);
      const straddlingSnapshot = runtime.snapshot();
      await stateRequested;
      const forking = runtime.forkBranch({
        sessionId: SESSION_ID,
        revision: sourceTree.revision,
        targetId: "u2",
      });
      await forkReplaced;

      const replacementSnapshot = await runtime.openSession(SESSION_ID);
      expect(replacementSnapshot.active).toMatchObject({
        sessionId: SESSION_ID,
        sessionFile: path,
      });

      releaseState();
      const completedSnapshot = await straddlingSnapshot;
      expect(completedSnapshot.active).toMatchObject({
        sessionId: SESSION_ID,
        sessionFile: path,
      });

      releaseFork();
      await expect(forking).resolves.toMatchObject({
        sessionId: worker.forkSessionId,
      });
      const sourceSlot = (
        runtime as unknown as {
          slots: Map<
            string,
            {
              sessionPath: string | null;
              persistenceExpectations: unknown[];
            }
          >;
        }
      ).slots.get(SESSION_ID);
      expect(sourceSlot?.sessionPath).toBe(path);
      expect(sourceSlot?.persistenceExpectations).toEqual([]);
      const reopened = await runtime.openSession(SESSION_ID);
      expect(reopened.active?.sessionFile).toBe(path);
      await vi.waitFor(() => expect(workers).toHaveLength(2));
      expect(workers[1]?.path).toBe(path);
    } finally {
      releaseState?.();
      releaseFork?.();
      await runtime.close();
    }
  });

  it("fails closed when a fork persistence claim disagrees with the destination entry", async () => {
    const { runtime, worker, directory } = await setup();
    worker.forkPath = join(directory, "forked-claim-mismatch.jsonl");
    worker.forkDestinationEntry = {
      type: "custom",
      id: "destination-state",
      parentId: "alt",
      timestamp: "2026-08-01T00:00:00.006Z",
      customType: "fork-state",
      data: { active: false },
    };
    worker.forkEventEntry = {
      ...worker.forkDestinationEntry,
      data: { active: true },
    };
    try {
      const sourceTree = await runtime.branchTree(SESSION_ID);
      await expect(
        runtime.forkBranch({
          sessionId: SESSION_ID,
          revision: sourceTree.revision,
          targetId: "u2",
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining(
          "differs from the worker's persistence claim",
        ),
      });
      expect(worker.stops).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("does not let native fork drain accepted queued input before replacement", async () => {
    const { runtime, worker } = await setup();
    try {
      worker.emit("event", {
        type: "queue_update",
        steering: [],
        followUp: ["queued follow-up"],
      });
      await vi.waitFor(async () =>
        expect((await runtime.snapshot()).pendingQueues?.followUp).toEqual([
          expect.objectContaining({ textPreview: "queued follow-up" }),
        ]),
      );
      const tree = await runtime.branchTree(SESSION_ID);

      await expect(
        runtime.forkBranch({
          sessionId: SESSION_ID,
          revision: tree.revision,
          targetId: "u2",
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: "Resume Pending and remove queued messages before forking",
      });
      expect(worker.commands.some((command) => command.type === "fork")).toBe(
        false,
      );
    } finally {
      await runtime.close();
    }
  });

  it("reserves fork identity and path while projection open races catalog refresh and destination open", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opening = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fixture = await setup(15_000, async (record) => {
      started();
      await gate;
      return SessionProjection.open(record);
    });
    const { runtime, worker, workers, directory, records, catalog } = fixture;
    worker.forkPath = join(directory, "forked-reserved.jsonl");
    records.set(worker.forkSessionId, {
      id: worker.forkSessionId,
      cwd: directory,
      path: worker.forkPath,
      source: null,
      created: new Date(),
      modified: new Date(),
      messageCount: 3,
      firstMessage: "root",
      searchText: "root",
    });
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      const forking = runtime.forkBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "u2",
      });
      await opening;
      await catalog.refresh(true);
      const openingDestination = runtime.openSession(worker.forkSessionId);
      await new Promise((resolveTick) => setTimeout(resolveTick, 10));
      expect(workers).toHaveLength(1);
      release();
      const [forked, opened] = await Promise.all([forking, openingDestination]);
      expect(opened.active?.sessionId).toBe(forked.sessionId);
      expect(workers).toHaveLength(1);
    } finally {
      release?.();
      await runtime.close();
    }
  });

  it("commits an accepted fork read-only when its worker exits during optional reads", async () => {
    const { runtime, worker, workers, directory } = await setup();
    worker.forkPath = join(directory, "forked-worker-exit.jsonl");
    worker.loseWorkerDuringForkExtras = true;
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      const forked = await runtime.forkBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "u2",
      });
      expect(forked).toMatchObject({
        sessionId: worker.forkSessionId,
        snapshot: {
          active: { sessionId: worker.forkSessionId },
          runState: "failed",
        },
      });
      expect(await runtime.snapshot()).toMatchObject({
        active: { sessionId: worker.forkSessionId },
        runState: "failed",
      });
      expect(workers).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("releases a failed fork reservation so destination open can recover with one fresh worker", async () => {
    let fail!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      fail = resolve;
    });
    const opening = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fixture = await setup(15_000, async () => {
      started();
      await gate;
      throw new Error("projection fixture failed");
    });
    const { runtime, worker, workers, directory, records } = fixture;
    worker.forkPath = join(directory, "forked-reservation-failure.jsonl");
    records.set(worker.forkSessionId, {
      id: worker.forkSessionId,
      cwd: directory,
      path: worker.forkPath,
      source: null,
      created: new Date(),
      modified: new Date(),
      messageCount: 3,
      firstMessage: "root",
      searchText: "root",
    });
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      const forking = runtime.forkBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "u2",
      });
      await opening;
      const openingDestination = runtime.openSession(worker.forkSessionId);
      fail();
      await expect(forking).rejects.toThrow(/projection fixture failed/);
      await expect(openingDestination).resolves.toMatchObject({
        active: { sessionId: worker.forkSessionId },
      });
      await vi.waitFor(() => expect(workers).toHaveLength(2));
      expect(workers[0]?.stops).toBe(1);
    } finally {
      fail?.();
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

  it("clears fork rebinding state after invalid final identity so a fresh source worker can recover", async () => {
    const { runtime, worker, directory } = await setup();
    worker.forkPath = join(directory, "forked-invalid.jsonl");
    worker.forkSessionId = SESSION_ID;
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      await expect(
        runtime.forkBranch({
          sessionId: SESSION_ID,
          revision: tree.revision,
          targetId: "u2",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(worker.stops).toBe(1);
      await expect(
        runtime.prompt({ sessionId: SESSION_ID, message: "recover source" }),
      ).resolves.toMatchObject({ text: "recover source" });
      expect(
        JSON.stringify(
          (await runtime.snapshot()).active?.transcriptPage.messages,
        ),
      ).toContain("recover source");
    } finally {
      await runtime.close();
    }
  });

  it("stops buffering and fails closed when the fork event cap is exceeded", async () => {
    const { runtime, worker, directory } = await setup();
    worker.forkPath = join(directory, "forked-overflow.jsonl");
    worker.forkEventCount = 1_001;
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      await expect(
        runtime.forkBranch({
          sessionId: SESSION_ID,
          revision: tree.revision,
          targetId: "u2",
        }),
      ).rejects.toMatchObject({ status: 504 });
      expect(worker.stops).toBe(1);
      expect((await runtime.snapshot()).runState).toBe("conflict");
    } finally {
      await runtime.close();
    }
  });

  it("keeps late fork overflow terminal while destination projection is opening", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opening = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fixture = await setup(15_000, async (record) => {
      started();
      await gate;
      return SessionProjection.open(record);
    });
    const { runtime, worker, directory, records } = fixture;
    worker.forkPath = join(directory, "forked-late-overflow.jsonl");
    worker.lateForkEventCount = 1_001;
    records.set(worker.forkSessionId, {
      id: worker.forkSessionId,
      cwd: directory,
      path: worker.forkPath,
      source: null,
      created: new Date(),
      modified: new Date(),
      messageCount: 3,
      firstMessage: "root",
      searchText: "root",
    });
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      const forking = runtime.forkBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "u2",
      });
      await opening;
      worker.emitLateForkEvents();
      await vi.waitFor(() => expect(worker.stops).toBe(1));
      release();
      await expect(forking).rejects.toMatchObject({ status: 504 });
      expect(runtime.activeSessionId).toBe(SESSION_ID);
      expect(
        (runtime as unknown as { slots: Map<string, unknown> }).slots.has(
          worker.forkSessionId,
        ),
      ).toBe(false);
    } finally {
      release?.();
      await runtime.close();
    }
  });

  it("does not let a slower fork steal a newer host selection intent", async () => {
    const { runtime, worker, directory } = await setup();
    worker.forkPath = join(directory, "forked-race.jsonl");
    let release!: () => void;
    let started!: () => void;
    worker.forkGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    worker.forkStarted = started;
    try {
      const tree = await runtime.branchTree(SESSION_ID);
      const forking = runtime.forkBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "u2",
      });
      await dispatched;
      await runtime.openSession(SESSION_ID);
      release();
      const result = await forking;
      expect(result.sessionId).toBe(worker.forkSessionId);
      expect(runtime.activeSessionId).toBe(SESSION_ID);
    } finally {
      release?.();
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
