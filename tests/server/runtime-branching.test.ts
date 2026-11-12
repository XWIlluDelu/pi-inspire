import { readFileSync } from "node:fs";
import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentStore } from "../../server/attachments.js";
import type { PiRpcOptions, PiRpcProcess } from "../../server/pi-rpc.js";
import {
  RuntimeController,
  type RuntimeControllerOptions,
} from "../../server/runtime.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../server/session-catalog.js";
import {
  type StagedSessionFork,
  type StageSessionFork,
  stageSessionFork,
} from "../../server/session-fork.js";
import {
  type ProjectionReconcileResult,
  SessionProjection,
} from "../../server/session-projection.js";
import { nativeNavigationLeaf } from "../../shared/branch-node-actions.js";
import {
  deferredSignal,
  FakeRpc,
  workerAttachmentStore,
} from "./fixtures/runtime.js";
import { jsonl, messageEntry } from "./fixtures/session-jsonl.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const directories: string[] = [];
const stores: AttachmentStore[] = [];
const runtimes: RuntimeController[] = [];

const entry = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  content:
    | string
    | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
  timestamp: number,
) => messageEntry(id, parentId, { role, content, timestamp });

class BranchRpc extends FakeRpc {
  readonly path: string;
  readonly bridgeCommand: string;
  readonly statusKey: string;
  readonly workerId: string;
  leafId: string | null;
  resultMode:
    | "ok"
    | "wrong-nonce"
    | "wrong-worker"
    | "malformed"
    | "duplicate"
    | "missing"
    | "persist" = "ok";
  autoRetryGate: Promise<void> | null = null;
  private readonly knownEntries: Set<string>;

  override get available(): boolean {
    return this.stops === 0;
  }

  constructor(options: PiRpcOptions) {
    super(options);
    const marker = options.args!.indexOf("--session");
    this.path = resolve(options.args![marker + 1]!);
    this.bridgeCommand = options.env!.INSPIRE_BRANCH_COMMAND!;
    this.statusKey = options.env!.INSPIRE_BRANCH_STATUS_KEY!;
    this.workerId = options.env!.INSPIRE_BRANCH_WORKER_ID!;
    const persisted = readFileSync(this.path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    this.knownEntries = new Set(
      persisted.slice(1).map((item) => String(item.id)),
    );
    this.sessionId = String(persisted[0]?.id ?? "");
    this.leafId = (persisted.at(-1)?.id as string | undefined) ?? null;
    this.responseOverrides.set("get_state", () => ({
      sessionId: this.sessionId,
      sessionFile: this.path,
      thinkingLevel: "off",
    }));
    this.responseOverrides.set("get_commands", {
      commands: [
        { name: this.bridgeCommand, source: "extension" },
        { name: "visible", source: "extension" },
      ],
    });
    this.responseOverrides.set(
      "get_entries",
      (command: Record<string, unknown>) => {
        if (
          command.since !== undefined &&
          !this.knownEntries.has(String(command.since))
        )
          throw new Error(`Entry not found: ${command.since}`);
        return { entries: [], leafId: this.leafId };
      },
    );
    this.responseOverrides.set(
      "set_auto_retry",
      async () => this.autoRetryGate,
    );
    this.responseOverrides.set(
      "prompt",
      async (command: Record<string, unknown>) => {
        const text = String(command.message);
        if (text.startsWith(`/${this.bridgeCommand} `)) {
          await this.emitBridge(text);
        } else {
          const persisted = entry("next-user", this.leafId, "user", text, 50);
          await appendFile(this.path, jsonl(persisted));
          this.leafId = persisted.id;
          this.knownEntries.add(persisted.id);
          this.emit("event", {
            type: "message_end",
            message: persisted.message,
          });
        }
        return {};
      },
    );
  }

  private async emitBridge(message: string): Promise<void> {
    const encoded = message.slice(message.indexOf(" ") + 1);
    const request = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const beforeLeaf = this.leafId;
    const target = (await readFile(this.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((candidate) => candidate.id === request.targetId);
    this.leafId = nativeNavigationLeaf(
      { ...target, role: target.message?.role },
      beforeLeaf,
    );
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
      ok: true,
      cancelled: false,
      beforeLeaf,
      effectiveLeaf: this.leafId,
      navigationLeaf: this.leafId,
    };
    if (this.resultMode === "persist") {
      await appendFile(
        this.path,
        jsonl(
          entry("unexpected", this.leafId, "assistant", "unexpected write", 60),
        ),
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
}

async function setup({
  branchBridgeTimeoutMs = 15_000,
  openForkProjection,
  stageFork,
  userContent = "second question",
  externallyOwned = false,
}: {
  branchBridgeTimeoutMs?: number;
  openForkProjection?: RuntimeControllerOptions["openForkProjection"];
  stageFork?: StageSessionFork;
  userContent?: Parameters<typeof entry>[3];
  externallyOwned?: boolean;
} = {}) {
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
    entry("u2", "a1", "user", userContent, 3),
    entry("a2", "u2", "assistant", "second answer", 4),
  ];
  await writeFile(path, jsonl(...lines));
  const record: SessionRecord = {
    id: SESSION_ID,
    cwd: directory,
    path,
    source: null,
    created: new Date(),
    modified: new Date(),
    messageCount: 4,
    firstMessage: "root",
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
  const attachments = workerAttachmentStore(join(directory, "uploads"));
  stores.push(attachments);
  let worker!: BranchRpc;
  const workers: BranchRpc[] = [];
  const runtime = new RuntimeController(catalog, attachments, {
    createProcess: (options) => {
      worker = new BranchRpc(options);
      workers.push(worker);
      return worker as unknown as PiRpcProcess;
    },
    branchBridgeTimeoutMs,
    openForkProjection,
    stageFork,
  });
  runtimes.push(runtime);
  if (externallyOwned)
    runtime.setExternalSessionPresence(async (id) =>
      id === SESSION_ID ? ["a2"] : [],
    );
  await runtime.openSession(SESSION_ID);
  if (externallyOwned) {
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).active?.readOnlyReason).toBe(
        "external-active",
      ),
    );
  } else {
    await vi.waitFor(() => expect(worker).toBeDefined());
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).active?.commands).toBeDefined(),
    );
  }
  return {
    runtime,
    worker,
    workers,
    path,
    directory,
    records,
    catalog,
    attachments,
  };
}

async function openOtherSession(fixture: Awaited<ReturnType<typeof setup>>) {
  const source = fixture.records.get(SESSION_ID)!;
  const record = {
    ...source,
    id: OTHER_SESSION_ID,
    path: join(fixture.directory, "other-session.jsonl"),
  };
  await writeFile(
    record.path,
    (await readFile(source.path, "utf8")).replace(SESSION_ID, OTHER_SESSION_ID),
  );
  fixture.records.set(record.id, record);
  await fixture.runtime.openSession(record.id);
}

async function addressedBranch(runtime: RuntimeController, targetId = "u2") {
  const { active } = await runtime.snapshot(SESSION_ID);
  return {
    sessionId: SESSION_ID,
    viewId: active!.transcriptPage.viewId,
    targetId,
  };
}

afterEach(async () => {
  try {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  } finally {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
});

describe("stock RPC branch bridge", () => {
  it("reads retained history through append and retires the old view after Stop and Edit", async () => {
    const { runtime, worker, path } = await setup();
    const text = "Retained content. ".repeat(4000);
    const saved = {
      ...entry("resources", "a2", "user", text, 40),
      message: {
        role: "user",
        content: [
          { type: "text", text },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
        timestamp: 40,
      },
    };
    await appendFile(path, jsonl(saved));
    worker.leafId = saved.id;
    worker.emit("event", { type: "message_end", message: saved.message });
    const snapshot = await runtime.snapshot();
    const request = {
      sessionId: SESSION_ID,
      viewId: snapshot.active!.transcriptPage.viewId,
      targetId: saved.id,
    };
    const first = await runtime.branchEntry(request);
    expect(first.nextOffset).toBe(32_000);
    await runtime.prompt({ sessionId: SESSION_ID, message: "New input" });
    worker.emit("event", { type: "agent_settled" });
    const next = await runtime.branchEntry({
      ...request,
      offset: first.nextOffset!,
    });
    expect(next.text).toBe(text.slice(32_000, 64_000));
    expect((await runtime.branchImage(request, 1)).data.toString()).toBe(
      "image",
    );
    worker.emit("event", { type: "agent_start" });
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).runState).toBe("running"),
    );
    await runtime.abort(SESSION_ID, request.viewId);
    worker.emit("event", { type: "agent_settled", aborted: true });
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).runState).toBe("aborted"),
    );
    const tree = await runtime.branchTree(SESSION_ID);
    const edited = await runtime.navigateBranch({
      sessionId: SESSION_ID,
      revision: tree.revision,
      targetId: "u2",
      mode: "edit",
    });
    expect(edited.editorText).toBe("second question");
    const commands = worker.commands.length;
    await expect(
      runtime.recoverPending(SESSION_ID, request.viewId),
    ).rejects.toMatchObject({ code: "PENDING_VIEW_CHANGED" });
    await expect(
      runtime.abort(SESSION_ID, request.viewId),
    ).rejects.toMatchObject({ code: "PENDING_VIEW_CHANGED" });
    expect(worker.commands).toHaveLength(commands);
    await expect(runtime.branchEntry(request)).rejects.toMatchObject({
      status: 409,
    });
    await expect(runtime.branchImage(request, 1)).rejects.toMatchObject({
      status: 409,
    });
  });

  it.each(["Stop", "worker exit"] as const)(
    "does not restore a navigation lease retired by %s during final reconciliation",
    async (retirement) => {
      const { runtime, worker, workers, path } = await setup();
      const reconciling = deferredSignal();
      const release = deferredSignal();
      const internal = runtime as unknown as {
        slots: Map<string, RuntimeSlot>;
        reconcileSlot(
          slot: RuntimeSlot,
          force?: boolean,
        ): Promise<ProjectionReconcileResult>;
      };
      const slot = internal.slots.get(SESSION_ID)!;
      const reconcile = internal.reconcileSlot.bind(runtime);
      const request = worker.request.bind(worker);
      let verified = false;
      vi.spyOn(worker, "request").mockImplementation(async (command) => {
        const result = await request(command);
        if (command.type === "get_entries") verified = true;
        return result;
      });
      vi.spyOn(internal, "reconcileSlot").mockImplementation(
        async (...args) => {
          const result = await reconcile(...args);
          if (verified) {
            verified = false;
            reconciling.resolve();
            await release.promise;
          }
          return result;
        },
      );
      let navigation: Promise<unknown> | undefined;
      try {
        const tree = await runtime.branchTree(SESSION_ID);
        const source = await readFile(path, "utf8");
        navigation = runtime
          .navigateBranch({
            sessionId: SESSION_ID,
            revision: tree.revision,
            targetId: "a1",
            mode: "switch",
          })
          .catch((error: unknown) => error);
        await reconciling.promise;
        expect(worker.leafId).toBe("a1");
        if (retirement === "Stop") await runtime.abort(SESSION_ID);
        else worker.emit("exit", new Error("Branch worker exited"));
        expect(slot.process).toBeNull();
        expect(slot.pendingBranchBridge).toBeNull();
        expect(worker.stops).toBe(1);
        release.resolve();
        expect(await navigation).toMatchObject({
          status: 409,
          message:
            "Branch navigation worker stopped before the result could be applied",
        });
        // Both the immediate response view and a later read must use disk's
        // saved branch; a retired worker cannot own an in-memory earlier leaf.
        for (let read = 0; read < 2; read += 1) {
          const snapshot = await runtime.snapshot(SESSION_ID);
          expect(snapshot).toMatchObject({
            runState: retirement === "Stop" ? "aborted" : "failed",
            active: {
              durableLeafId: "a2",
              effectiveLeafId: "a2",
              navigationLeased: false,
            },
          });
          expect(
            JSON.stringify(snapshot.active?.transcriptPage.messages),
          ).toContain("second answer");
          expect(slot.navigationLease).toBeNull();
        }
        expect(await readFile(path, "utf8")).toBe(source);
        expect(workers).toHaveLength(1);
        expect(worker.stops).toBe(1);
        expect(
          worker.commands.filter((command) => command.type === "prompt"),
        ).toHaveLength(1);
      } finally {
        release.resolve();
        await navigation;
        await runtime.close();
      }
    },
  );

  it("does not silently edit a non-default user-message branch end", async () => {
    const { runtime, workers, path } = await setup({ externallyOwned: true });
    await appendFile(
      path,
      jsonl(
        entry("unfinished", "a1", "user", "Unanswered side branch", 5),
        entry("saved", "a2", "assistant", "Saved default", 6),
      ),
    );
    runtime.setExternalSessionPresence(async () => []);
    await runtime.takeOverSession(SESSION_ID);
    await expect(
      runtime.selectBranch(SESSION_ID, "unfinished"),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Use Edit from here"),
    });
    expect(workers[0]!.leafId).toBe("saved");
    const tree = await runtime.branchTree(SESSION_ID);
    const edited = await runtime.navigateBranch({
      sessionId: SESSION_ID,
      targetId: "unfinished",
      mode: "edit",
      revision: tree.revision,
    });
    expect(edited.editorText).toBe("Unanswered side branch");
    expect(edited.snapshot.active?.effectiveLeafId).toBe("a1");
  });

  it.each([
    "wrong-nonce",
    "wrong-worker",
    "malformed",
    "duplicate",
    "missing",
    "persist",
  ] as const)(
    "stops the writer without retrying when native navigation is unverified (%s)",
    async (mode) => {
      const { runtime, worker } = await setup({
        branchBridgeTimeoutMs: mode === "missing" ? 25 : undefined,
      });
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
      expect(
        worker.commands.filter((command) => command.type === "prompt"),
      ).toHaveLength(1);
    },
  );

  it.each([
    { mode: "fork", targetId: "u2", entries: ["u1", "a1"] },
    { mode: "clone", targetId: "u2", entries: ["u1", "a1", "u2"] },
    { mode: "clone", targetId: "a2", entries: ["u1", "a1", "u2", "a2"] },
  ] as const)(
    "$mode at $targetId reads an externally owned source while its tail advances",
    async ({ mode, targetId, entries }) => {
      const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
      const partial = '{"type":"message"';
      let stagedBytes!: string;
      const { runtime, workers, path } = await setup({
        async stageFork(request) {
          // The external Pi can start another frame after runtime admission.
          await appendFile(request.sourcePath, partial);
          const staged = await stageSessionFork(request);
          stagedBytes = await readFile(staged.stagedPath, "utf8");
          return staged;
        },
        userContent: [{ type: "text", text: "second question" }, image],
        externallyOwned: true,
      });
      const release = runtime.retainSessionView(SESSION_ID);
      try {
        const original = await readFile(path, "utf8");
        const tree = await runtime.branchTree(SESSION_ID);
        await expect(
          runtime.navigateBranch({
            sessionId: SESSION_ID,
            revision: tree.revision,
            targetId: "u2",
            mode: "edit",
          }),
        ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });
        const request = await addressedBranch(runtime, targetId);
        // The target is unchanged when the external Pi appends after the
        // browser captured its view/endpoint but before copy admission.
        const appended = jsonl(
          entry("later", "a2", "assistant", "later progress", 50),
        );
        await appendFile(path, appended);
        runtime.setExternalSessionPresence(async (id) =>
          id === SESSION_ID ? ["later"] : [],
        );
        const copied = await (mode === "fork"
          ? runtime.forkBranch(request)
          : runtime.cloneBranch(request));
        expect(copied.sessionId).not.toBe(SESSION_ID);
        expect(copied.editorText).toBe(
          mode === "fork" ? "second question" : "",
        );
        expect(await readFile(path, "utf8")).toBe(
          original + appended + partial,
        );
        const output = await readFile(
          copied.snapshot.active!.sessionFile!,
          "utf8",
        );
        expect(output).toBe(stagedBytes);
        const [header, ...copiedEntries] = output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(header).toMatchObject({
          id: copied.sessionId,
          cwd: copied.snapshot.active!.cwd,
          parentSession: path,
        });
        expect(copiedEntries.map(({ id }) => id)).toEqual(entries);
        expect(copied.snapshot.active?.durableLeafId).toBe(entries.at(-1));
        if (mode === "clone") {
          expect(copied.editorAttachments).toBeUndefined();
          expect(output).toContain(image.data);
        } else {
          expect(copied.editorAttachments).toHaveLength(1);
          expect(output).not.toContain(image.data);
        }
        expect((await runtime.branchTree(SESSION_ID)).revision).toBeGreaterThan(
          tree.revision,
        );
        expect(
          (await runtime.snapshot(SESSION_ID)).active?.readOnlyReason,
        ).toBe("external-active");
        await vi.waitFor(() => expect(workers).toHaveLength(1));
        expect(workers[0]!.sessionId).toBe(copied.sessionId);
      } finally {
        release();
        await runtime.close();
      }
    },
  );

  it("forks an unselected busy session without losing its queued input or dialog", async () => {
    const fixture = await setup();
    const { runtime, worker, path } = fixture;
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
    const busySource = {
      active: { sessionId: SESSION_ID },
      runState: "running",
      pendingExtensionUiRequests: [
        { id: "source-dialog", sessionId: SESSION_ID },
      ],
      pendingQueues: {
        steering: [expect.objectContaining({ textPreview: "steer later" })],
        followUp: [expect.objectContaining({ textPreview: "follow later" })],
      },
    };
    await vi.waitFor(async () =>
      expect(await runtime.snapshot()).toMatchObject(busySource),
    );
    const sourceBefore = await readFile(path, "utf8");
    const request = {
      sessionId: SESSION_ID,
      viewId: (await runtime.snapshot()).active!.transcriptPage.viewId,
    };
    expect(
      await runtime.branchEntry({ ...request, targetId: "a1" }),
    ).toMatchObject({ text: expect.stringContaining("first answer") });
    await expect(
      runtime.navigateBranch({
        sessionId: SESSION_ID,
        revision: (await runtime.branchTree(SESSION_ID)).revision,
        targetId: "a1",
        mode: "switch",
      }),
    ).rejects.toMatchObject({ status: 409 });

    await openOtherSession(fixture);
    expect(
      await runtime.forkBranch({ ...request, targetId: "u2" }),
    ).toMatchObject({
      sessionId: expect.any(String),
      editorText: "second question",
      snapshot: { active: { durableLeafId: "a1" } },
    });
    expect(runtime.activeSessionId).toBe(OTHER_SESSION_ID);
    expect(await runtime.snapshot(SESSION_ID)).toMatchObject(busySource);
    expect(await readFile(path, "utf8")).toBe(sourceBefore);
    expect(worker.stops).toBe(0);
  });

  it("validates the addressed Fork source and preserves a newer selection before admission", async () => {
    const stageFork = vi.fn(stageSessionFork);
    const fixture = await setup({ stageFork });
    const { runtime, worker } = fixture;
    const tree = await runtime.branchTree(SESSION_ID);
    await openOtherSession(fixture);
    const request = {
      sessionId: SESSION_ID,
      viewId: (await runtime.snapshot(SESSION_ID)).active!.transcriptPage
        .viewId,
      targetId: "u2",
    };
    await expect(
      runtime.forkBranch({ ...request, sessionId: "unknown-session" }),
    ).rejects.toThrow("That session is not open on this host");
    await expect(
      runtime.forkBranch({ ...request, viewId: "retired-source-view" }),
    ).rejects.toThrow(/branch changed/);
    await expect(
      runtime.forkBranch({ ...request, targetId: "a1" }),
    ).rejects.toThrow("Fork requires a retained user message");
    await runtime.navigateBranch({
      sessionId: SESSION_ID,
      revision: tree.revision,
      targetId: "a1",
      mode: "switch",
    });
    await expect(runtime.forkBranch(request)).rejects.toThrow(/branch changed/);
    expect(runtime.activeSessionId).toBe(OTHER_SESSION_ID);
    const source = await addressedBranch(runtime);
    const gate = deferredSignal();
    worker.autoRetryGate = gate.promise;
    const changing = runtime.setAutoRetry(SESSION_ID, false);
    try {
      await vi.waitFor(() =>
        expect(worker.commands).toContainEqual({
          type: "set_auto_retry",
          enabled: false,
        }),
      );
      const forking = runtime.forkBranch(source);
      await runtime.openSession(SESSION_ID);
      const retainedLeaf = (await runtime.snapshot(SESSION_ID)).active!
        .effectiveLeafId;
      gate.resolve();
      await changing;
      const forked = await forking;
      expect(forked.editorText).toBe("second question");
      expect(stageFork).toHaveBeenCalledTimes(1);
      expect(
        await readFile(forked.snapshot.active!.sessionFile!, "utf8"),
      ).toContain("first answer");
      expect(runtime.activeSessionId).toBe(SESSION_ID);
      expect((await runtime.snapshot(SESSION_ID)).active?.effectiveLeafId).toBe(
        retainedLeaf,
      );
    } finally {
      gate.resolve();
      await changing;
    }
  });

  it("holds the generated destination reservation across publication and a slower final projection open", async () => {
    const { promise: gate, resolve: release } = deferredSignal();
    const { promise: finalOpen, resolve: opened } = deferredSignal();
    let recordsRef!: Map<string, SessionRecord>;
    let destination!: string;
    const fixture = await setup({
      async openForkProjection(record) {
        if (record.path.includes(".inspire-fork-")) {
          return SessionProjection.open(record);
        }
        recordsRef.set(record.id, record);
        destination = record.id;
        opened();
        await gate;
        return SessionProjection.open(record);
      },
    });
    const { runtime, workers, records } = fixture;
    recordsRef = records;
    try {
      const forking = runtime.forkBranch(await addressedBranch(runtime));
      await finalOpen;
      const openingDestination = runtime.openSession(destination);
      await runtime.openSession(SESSION_ID);
      release();
      const [forked, openedDestination] = await Promise.all([
        forking,
        openingDestination,
      ]);
      expect(forked.sessionId).toBe(destination);
      expect(openedDestination.active?.sessionId).toBe(destination);
      expect(runtime.activeSessionId).toBe(SESSION_ID);
      await vi.waitFor(() =>
        expect(
          workers.filter((candidate) => candidate.sessionId === destination),
        ).toHaveLength(1),
      );
    } finally {
      release?.();
      await runtime.close();
    }
  });

  it("restages an image-only Fork preserving image order and duplicates", async () => {
    const images = [
      {
        type: "image",
        data: Buffer.from("first image").toString("base64"),
        mimeType: "image/png",
      },
      {
        type: "image",
        data: Buffer.from("second image").toString("base64"),
        mimeType: "image/webp",
      },
    ];
    images.push(images[0]!);
    const { runtime, workers, worker, path, attachments } = await setup({
      userContent: images,
    });
    const original = await readFile(path, "utf8");
    const forked = await runtime.forkBranch(await addressedBranch(runtime));
    expect(forked.editorText).toBe("");
    const restored = forked.editorAttachments!;
    expect(restored).toHaveLength(3);
    expect(new Set(restored.map((item) => item.id)).size).toBe(3);
    for (const [index, item] of restored.entries()) {
      expect(item).toMatchObject({
        kind: "image",
        mimeType: images[index]!.mimeType,
      });
      const preview = await attachments.imagePreview(item.id);
      expect(preview.bytes.toString("base64")).toBe(images[index]!.data);
    }
    expect(await readFile(path, "utf8")).toBe(original);
    expect(
      await readFile(forked.snapshot.active!.sessionFile!, "utf8"),
    ).not.toContain('"id":"u2"');
    expect(worker.stops).toBe(0);
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(
      workers[1]!.commands.some((command) => command.type === "prompt"),
    ).toBe(false);

    // Removing one copy leaves the original persisted input and its duplicates intact.
    await attachments.remove(restored[1]!.id);
    await expect(
      attachments.imagePreview(restored[1]!.id),
    ).rejects.toMatchObject({ status: 404 });
    await runtime.prompt({
      sessionId: forked.sessionId,
      message: "",
      attachmentIds: [restored[0]!.id, restored[2]!.id],
    });
    expect(
      workers[1]!.commands.find((command) => command.type === "prompt"),
    ).toMatchObject({
      message: "",
      images: [images[0], images[0]],
    });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("rejects an atomic destination-path collision without changing the source", async () => {
    let destinationPath!: string;
    const { runtime, worker, path, attachments } = await setup({
      async stageFork(request) {
        const fork = await stageSessionFork(request);
        destinationPath = fork.destinationPath;
        await writeFile(destinationPath, "existing destination\n");
        return fork;
      },
      userContent: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
    });
    const staging = vi.spyOn(attachments, "stageImages");
    const sourceBefore = await readFile(path, "utf8");
    await expect(
      runtime.forkBranch(await addressedBranch(runtime)),
    ).rejects.toMatchObject({ status: 409 });
    const copied = await staging.mock.results[0]!.value;
    expect(copied).toHaveLength(1);
    await expect(attachments.imagePreview(copied[0]!.id)).rejects.toMatchObject(
      { status: 404 },
    );
    expect(await readFile(destinationPath, "utf8")).toBe(
      "existing destination\n",
    );
    expect(await readFile(path, "utf8")).toBe(sourceBefore);
    expect(worker.stops).toBe(0);
    expect(worker.commands.some((command) => command.type === "fork")).toBe(
      false,
    );
  });

  it("refuses a rewritten prefix after admission and discards private staging", async () => {
    const { runtime, directory } = await setup({
      async stageFork(request) {
        const source = await readFile(request.sourcePath, "utf8");
        await writeFile(
          request.sourcePath,
          source.replace("first answer", "other answer"),
        );
        return stageSessionFork(request);
      },
    });
    const before = (await readdir(directory)).sort();
    await expect(
      runtime.forkBranch(await addressedBranch(runtime)),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("changed before its fork boundary"),
    });
    expect((await readdir(directory)).sort()).toEqual(before);
  });

  it("reports a published destination as committed when final attachment fails", async () => {
    let opens = 0;
    let staged!: StagedSessionFork;
    const { runtime, worker } = await setup({
      async openForkProjection(record) {
        opens += 1;
        if (opens === 1) return SessionProjection.open(record);
        throw new Error("projection fixture failed");
      },
      async stageFork(request) {
        staged = await stageSessionFork(request);
        return staged;
      },
    });
    const outcome = await runtime
      .forkBranch({
        sessionId: SESSION_ID,
        viewId: (await runtime.snapshot(SESSION_ID)).active!.transcriptPage
          .viewId,
        targetId: "u2",
      })
      .catch((error: unknown) => error);
    expect(outcome).toMatchObject({
      status: 409,
      message: expect.stringContaining(
        `Fork created Session ${staged.destinationId}`,
      ),
    });
    expect(await readFile(staged.destinationPath, "utf8")).toContain(
      '"id":"a1"',
    );
    expect(worker.stops).toBe(0);
    expect((await runtime.snapshot()).runState).not.toBe("conflict");
  });

  it("follows the viewed branch while another Pi runs it and switches by the same admission rule", async () => {
    const { runtime, path } = await setup({ externallyOwned: true });
    const release = runtime.retainSessionView(SESSION_ID);
    try {
      // A live Pi runs the a2 branch; someone else starts another branch.
      await appendFile(
        path,
        jsonl(
          entry("alt", "a1", "user", "alternative", 5),
          entry("alt-a", "alt", "assistant", "alternative answer", 6),
        ),
      );
      const listed = await runtime.branchLeaves(SESSION_ID);
      expect(listed.total).toBe(2);
      expect(listed.leaves).toEqual([
        expect.objectContaining({
          id: "alt-a",
          excerpt: "alternative",
          isDefault: true,
          isCurrent: false,
        }),
        expect.objectContaining({
          id: "a2",
          isDefault: false,
          isCurrent: true,
        }),
      ]);

      // No Pi runs the other branch: it opens editable here.
      const editable = await runtime.selectBranch(SESSION_ID, "alt-a");
      expect(editable.active?.readOnlyReason).toBeUndefined();
      expect(JSON.stringify(editable.active?.transcriptPage)).toContain(
        "alternative answer",
      );

      // Back to the branch the live Pi runs: read-only again.
      const watched = await runtime.selectBranch(SESSION_ID, "a2");
      expect(watched.active?.readOnlyReason).toBe("external-active");
      expect(JSON.stringify(watched.active?.transcriptPage)).toContain(
        "second answer",
      );
    } finally {
      release();
      await runtime.close();
    }
  });

  it.each([
    { view: "latest", target: "a2", foreignParent: "a1" },
    { view: "earlier", target: "a1", foreignParent: "a2" },
  ])(
    "keeps a worker on its $view branch across foreign appends",
    async ({ target, foreignParent }) => {
      const { runtime, worker, path } = await setup();
      if (target === "a1") {
        const tree = await runtime.branchTree(SESSION_ID);
        await runtime.navigateBranch({
          sessionId: SESSION_ID,
          revision: tree.revision,
          targetId: target,
          mode: "switch",
        });
      }
      for (const id of ["foreign-one", "foreign-two"]) {
        await appendFile(
          path,
          jsonl(entry(id, foreignParent, "assistant", id, 60)),
        );
        const tree = await runtime.branchTree(SESSION_ID);
        expect(tree.durableLeafId).toBe(id);
        expect(tree.effectiveLeafId).toBe(target);
        expect(worker.leafId).toBe(target);
        const snapshot = await runtime.snapshot(SESSION_ID);
        expect(snapshot.runState).not.toBe("conflict");
        expect(
          JSON.stringify(snapshot.active?.transcriptPage.messages),
        ).not.toContain(id);
      }
    },
  );
});
