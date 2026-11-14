import { readFileSync } from "node:fs";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiRpcOptions, PiRpcProcess } from "../../server/pi-rpc.js";
import {
  RuntimeController,
  type RuntimeControllerOptions,
} from "../../server/runtime.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";
import { SessionCatalog } from "../../server/session-catalog.js";
import { stageSessionFork } from "../../server/session-fork.js";
import {
  type ProjectionReconcileResult,
  SessionProjection,
} from "../../server/session-projection.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";
import {
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  fixtureWorkspace,
  initializeRuntimeFixture,
  trackedAttachmentStore,
  trackRuntime,
} from "./fixtures/runtime.js";
import { jsonl, messageEntry } from "./fixtures/session-jsonl.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "33333333-3333-4333-8333-333333333333";
let workspace: Awaited<ReturnType<typeof nativePiWorkspace>>;
const image = {
  type: "image",
  data: "aW1hZ2U=",
  mimeType: "image/png",
} as const;
const entry = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  content:
    | string
    | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
  timestamp: number,
) => messageEntry(id, parentId, { role, content, timestamp });

const parseLines = (bytes: string): Record<string, unknown>[] =>
  bytes
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

/** Hold or corrupt the reply for the suite's earlier anchor. Native graph
 * selection is exercised separately by pi-branch-bridge.integration.test.ts. */
class BranchRpc extends FakeRpc {
  leafId: string | null;
  fault?:
    | "wrong-nonce"
    | "wrong-worker"
    | "malformed"
    | "duplicate"
    | "missing"
    | "persist";
  private readonly entries: Record<string, unknown>[];

  constructor(options: PiRpcOptions) {
    super(options);
    const [header, ...entries] = parseLines(
      readFileSync(this.sessionPath!, "utf8"),
    );
    this.sessionId = String(header!.id);
    this.entries = entries;
    this.leafId = (entries.at(-1)?.id as string | undefined) ?? null;
    const {
      INSPIRE_BRANCH_COMMAND: command,
      INSPIRE_BRANCH_STATUS_KEY: statusKey,
      INSPIRE_BRANCH_WORKER_ID: workerId,
    } = options.env!;
    this.responseOverrides.set(
      "get_entries",
      ({ since }: Record<string, unknown>) => {
        const index =
          since === undefined
            ? -1
            : this.entries.findIndex(({ id }) => id === since);
        if (since !== undefined && index < 0)
          throw new Error(`Entry not found: ${since}`);
        return { entries: this.entries.slice(index + 1), leafId: this.leafId };
      },
    );
    this.responseOverrides.set(
      "prompt",
      async ({ message }: Record<string, unknown>) => {
        if (typeof message !== "string" || !message.startsWith(`/${command} `))
          return {};
        const request = JSON.parse(
          Buffer.from(message.split(" ")[1]!, "base64url").toString(),
        );
        expect(request.targetId).toMatch(/^(?:a1|u2|unfinished)$/u);
        const beforeLeaf = this.leafId;
        this.leafId = "a1";
        const response = {
          v: 1,
          nonce: this.fault === "wrong-nonce" ? "foreign" : request.nonce,
          workerId: this.fault === "wrong-worker" ? "foreign" : workerId,
          sessionId: this.sessionId,
          ok: true,
          cancelled: false,
          beforeLeaf,
          effectiveLeaf: this.leafId,
          navigationLeaf: this.leafId,
        };
        if (this.fault === "persist") {
          const unexpected = entry(
            "unexpected",
            this.leafId,
            "assistant",
            "unexpected write",
            60,
          );
          this.leafId = unexpected.id;
          this.entries.push(unexpected);
          await appendFile(this.sessionPath!, jsonl(unexpected));
        }
        const event = {
          type: "extension_ui_request",
          method: "setStatus",
          statusKey,
          statusText:
            this.fault === "malformed"
              ? "not+base64"
              : Buffer.from(JSON.stringify(response)).toString("base64url"),
        };
        if (this.fault !== "missing") this.emit("event", event);
        if (this.fault === "duplicate") this.emit("event", event);
        return {};
      },
    );
  }

  override get available(): boolean {
    return this.stops === 0;
  }

  protected override checkpointLeaf() {
    return this.leafId;
  }
}

async function setup({
  userContent = "second question",
  external = false,
  cold = external,
  ...options
}: Pick<
  RuntimeControllerOptions,
  "branchBridgeTimeoutMs" | "openForkProjection" | "stageFork"
> & {
  userContent?: Parameters<typeof entry>[3];
  external?: boolean;
  cold?: boolean;
} = {}) {
  const { cwd, sessions: directory } = workspace;
  const path = join(directory, "session.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: SESSION_ID,
    timestamp: "2026-08-01T00:00:00.000Z",
    cwd,
  };
  const entries = [
    entry("u1", null, "user", "root", 1),
    entry("a1", "u1", "assistant", "first answer", 2),
    entry("u2", "a1", "user", userContent, 3),
    entry("a2", "u2", "assistant", "second answer", 4),
  ];
  const source = jsonl(header, ...entries);
  await writeFile(path, source);
  const catalog = new SessionCatalog(cwd);
  const attachments = trackedAttachmentStore();
  const workers: BranchRpc[] = [];
  const runtime = new RuntimeController(catalog, attachments, {
    ...options,
    createProcess: (options) => {
      const worker = new BranchRpc(options);
      workers.push(worker);
      return worker as unknown as PiRpcProcess;
    },
  });
  trackRuntime(runtime);
  if (external)
    runtime.setExternalSessionPresence(async (id) =>
      id === SESSION_ID ? ["a2"] : [],
    );
  await runtime.openSession(SESSION_ID);
  if (!cold) await runtime.setSteeringMode(SESSION_ID, "one-at-a-time");
  const openOther = async () => {
    await writeFile(
      join(directory, "other-session.jsonl"),
      jsonl({ ...header, id: OTHER_SESSION_ID }, ...entries),
    );
    catalog.invalidate();
    return runtime.openSession(OTHER_SESSION_ID);
  };
  return {
    runtime,
    workers,
    get worker() {
      return workers[0]!;
    },
    path,
    directory,
    catalog,
    attachments,
    source,
    openOther,
  };
}

async function addressedBranch(runtime: RuntimeController, targetId = "u2") {
  const { active } = await runtime.snapshot(SESSION_ID);
  return {
    sessionId: SESSION_ID,
    viewId: active!.transcriptPage.viewId,
    targetId,
  };
}

beforeEach(async () => {
  await initializeRuntimeFixture();
  workspace = await nativePiWorkspace(
    "pi-",
    { defaultProjectTrust: "never" },
    fixtureWorkspace,
  );
  stubNativePiEnvironment(workspace.env);
});
afterEach(async () => {
  try {
    await disposeRuntimeFixture();
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("stock RPC branch bridge", () => {
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
        const tree = (await runtime.snapshot(SESSION_ID)).active!;
        const source = await readFile(path, "utf8");
        navigation = runtime
          .navigateBranch({
            sessionId: SESSION_ID,
            revision: tree.branchRevision!,
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
            sessionStatuses: {
              [SESSION_ID]: {
                runState: retirement === "Stop" ? "aborted" : "failed",
              },
            },
            active: {
              durableLeafId: "a2",
              effectiveLeafId: "a2",
              navigationLeased: false,
            },
          });
          expect(
            JSON.stringify(snapshot.active?.transcriptPage.messages),
          ).toContain("second answer");
          expect(slot.workerView).toBeNull();
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
    const { runtime, workers, path } = await setup({ external: true });
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
      runtime.navigateBranch({
        sessionId: SESSION_ID,
        targetId: "unfinished",
        revision: (await runtime.snapshot(SESSION_ID)).active!.branchRevision!,
        mode: "watch",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Use Edit from here"),
    });
    expect(workers[0]!.leafId).toBe("saved");
    const tree = (await runtime.snapshot(SESSION_ID)).active!;
    const edited = await runtime.navigateBranch({
      sessionId: SESSION_ID,
      targetId: "unfinished",
      mode: "edit",
      revision: tree.branchRevision!,
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
      worker.fault = mode;
      const tree = (await runtime.snapshot(SESSION_ID)).active!;
      await expect(
        runtime.navigateBranch({
          sessionId: SESSION_ID,
          revision: tree.branchRevision!,
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
    { mode: "fork", targetId: "u2", copiedIds: ["u1", "a1"] },
    { mode: "clone", targetId: "u2", copiedIds: ["u1", "a1", "u2"] },
    { mode: "clone", targetId: "a2", copiedIds: ["u1", "a1", "u2", "a2"] },
  ] as const)(
    "$mode at $targetId copies the admitted prefix while another Pi appends",
    async ({ mode, targetId, copiedIds }) => {
      const partial = '{"type":"message"';
      const { runtime, workers, path, source } = await setup({
        async stageFork(request) {
          await appendFile(request.sourcePath, partial);
          return stageSessionFork(request);
        },
        userContent: [{ type: "text", text: "second question" }, image],
        external: true,
      });
      const release = runtime.retainSessionView(SESSION_ID);
      try {
        const tree = (await runtime.snapshot(SESSION_ID)).active!;
        await expect(
          runtime.navigateBranch({
            sessionId: SESSION_ID,
            revision: tree.branchRevision!,
            targetId: "u2",
            mode: "edit",
          }),
        ).rejects.toMatchObject({ code: "EXTERNAL_PI_WRITER_ACTIVE" });
        const request = await addressedBranch(runtime, targetId);
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
        const bytes = await readFile(
          copied.snapshot.active!.sessionFile!,
          "utf8",
        );
        const [header, ...entries] = parseLines(bytes);
        expect(header).toMatchObject({
          id: copied.sessionId,
          cwd: copied.snapshot.active!.cwd,
          parentSession: path,
        });
        expect(entries.map(({ id }) => id)).toEqual(copiedIds);
        expect(copied.snapshot.active?.durableLeafId).toBe(copiedIds.at(-1));
        expect(copied.editorText).toBe(
          mode === "fork" ? "second question" : "",
        );
        expect(copied.editorAttachments?.length ?? 0).toBe(
          mode === "fork" ? 1 : 0,
        );
        expect(bytes.includes(image.data)).toBe(mode === "clone");
        expect(await readFile(path, "utf8")).toBe(source + appended + partial);
        expect((await runtime.snapshot(SESSION_ID)).active).toMatchObject({
          readOnlyReason: "external-active",
          effectiveLeafId: "later",
        });
        expect(workers).toHaveLength(0);
      } finally {
        release();
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
      sessionStatuses: { [SESSION_ID]: { runState: "running" } },
      pendingExtensionUiRequests: [
        { id: "source-dialog", sessionId: SESSION_ID },
      ],
      pendingQueues: {
        steering: [expect.objectContaining({ textPreview: "steer later" })],
        followUp: [expect.objectContaining({ textPreview: "follow later" })],
      },
    };
    await vi.waitFor(async () =>
      expect(await runtime.snapshot(SESSION_ID)).toMatchObject(busySource),
    );
    const sourceBefore = await readFile(path, "utf8");
    const request = {
      sessionId: SESSION_ID,
      viewId: (await runtime.snapshot(SESSION_ID)).active!.transcriptPage
        .viewId,
    };
    expect(
      await runtime.sessionHistory(request.sessionId, request.viewId, {
        kind: "entry",
        targetId: "a1",
      }),
    ).toMatchObject({ text: expect.stringContaining("first answer") });
    await expect(
      runtime.navigateBranch({
        sessionId: SESSION_ID,
        revision: (await runtime.snapshot(SESSION_ID)).active!.branchRevision!,
        targetId: "a1",
        mode: "switch",
      }),
    ).rejects.toMatchObject({ status: 409 });

    await fixture.openOther();
    expect(
      await runtime.forkBranch({ ...request, targetId: "u2" }),
    ).toMatchObject({
      sessionId: expect.any(String),
      editorText: "second question",
      snapshot: { active: { durableLeafId: "a1" } },
    });
    expect(runtime.startupSessionHint).toBe(OTHER_SESSION_ID);
    expect(await runtime.snapshot(SESSION_ID)).toMatchObject(busySource);
    expect(await readFile(path, "utf8")).toBe(sourceBefore);
    expect(worker.stops).toBe(0);
  });

  it("validates the addressed Fork source and preserves a newer selection before admission", async () => {
    const stageFork = vi.fn(stageSessionFork);
    const fixture = await setup({ stageFork });
    const { runtime, worker } = fixture;
    const tree = (await runtime.snapshot(SESSION_ID)).active!;
    await fixture.openOther();
    const request = await addressedBranch(runtime);
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
      revision: tree.branchRevision!,
      targetId: "a1",
      mode: "switch",
    });
    await expect(runtime.forkBranch(request)).rejects.toThrow(/branch changed/);
    expect(runtime.startupSessionHint).toBe(OTHER_SESSION_ID);
    const source = await addressedBranch(runtime);
    const gate = deferredSignal();
    worker.responseOverrides.set("set_auto_retry", () => gate.promise);
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
      expect(runtime.startupSessionHint).toBe(SESSION_ID);
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
    let destination!: string;
    const { runtime, workers, catalog } = await setup({
      cold: true,
      async openForkProjection(record) {
        if (!record.path.includes(".inspire-fork-")) {
          destination = record.id;
          opened();
          await gate;
        }
        return SessionProjection.open(record);
      },
    });
    const forking = runtime.forkBranch(await addressedBranch(runtime));
    try {
      await Promise.race([finalOpen, forking]);
      await catalog.refresh(true);
      expect((await catalog.get(destination))?.id).toBe(destination);
      const openingDestination = runtime.openSession(destination);
      await runtime.openSession(SESSION_ID);
      release();
      const [forked, openedDestination] = await Promise.all([
        forking,
        openingDestination,
      ]);
      expect(forked.sessionId).toBe(destination);
      expect(openedDestination.active?.sessionId).toBe(destination);
      expect(runtime.startupSessionHint).toBe(SESSION_ID);
      expect(workers).toHaveLength(0);
      await runtime.setSteeringMode(destination, "one-at-a-time");
      expect(workers.map(({ sessionId }) => sessionId)).toEqual([destination]);
    } finally {
      release();
      await forking;
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
    expect(workers).toHaveLength(1);

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

  it.each([
    "prefix rewrite",
    "destination collision",
    "final projection",
  ] as const)("preserves the Fork commit boundary on %s", async (failure) => {
    const sourceChanged = failure === "prefix rewrite";
    let staged: Awaited<ReturnType<typeof stageSessionFork>> | undefined;
    const { runtime, directory, path, source, attachments, workers } =
      await setup({
        cold: true,
        userContent: [image],
        async stageFork(request) {
          if (sourceChanged)
            await writeFile(
              path,
              source.replace("first answer", "other answer"),
            );
          staged = await stageSessionFork(request);
          if (failure === "destination collision")
            await writeFile(staged.destinationPath, "existing destination\n");
          return staged;
        },
        async openForkProjection(record) {
          if (
            failure === "final projection" &&
            record.path === staged?.destinationPath
          )
            throw new Error("projection fixture failed");
          return SessionProjection.open(record);
        },
      });
    const images = vi.spyOn(attachments, "stageImages");
    const outcome = await runtime
      .forkBranch(await addressedBranch(runtime))
      .catch((error: unknown) => error);
    expect(outcome).toMatchObject({
      status: 409,
      message: expect.stringContaining(
        sourceChanged
          ? "changed before its fork boundary"
          : failure === "destination collision"
            ? "destination already exists"
            : `Fork created Session ${staged!.destinationId}`,
      ),
    });
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith(".inspire-fork-"),
      ),
    ).toEqual([]);
    expect(workers).toHaveLength(0);
    if (sourceChanged) {
      expect(images).not.toHaveBeenCalled();
      return;
    }
    const [abandoned] = await images.mock.results[0]!.value;
    await expect(attachments.imagePreview(abandoned!.id)).rejects.toMatchObject(
      { status: 404 },
    );
    const bytes = await readFile(staged!.destinationPath, "utf8");
    if (failure === "destination collision")
      expect(bytes).toBe("existing destination\n");
    else {
      expect(parseLines(bytes).at(-1)).toMatchObject({ id: "a1" });
      expect(
        (await runtime.openSession(staged!.destinationId)).active?.sessionId,
      ).toBe(staged!.destinationId);
    }
    expect(await readFile(path, "utf8")).toBe(source);
  });

  it("keeps History on the same view through an append, then fences it when Watch changes ownership", async () => {
    const text = "Retained content. ".repeat(4000);
    const { runtime, path, workers } = await setup({
      external: true,
      userContent: [{ type: "text", text }, image],
    });
    const release = runtime.retainSessionView(SESSION_ID);
    try {
      let old = await addressedBranch(runtime);
      const read = (offset?: number) =>
        runtime.sessionHistory(SESSION_ID, old.viewId, {
          kind: "entry",
          targetId: old.targetId,
          offset,
        });
      const first = await read();
      expect(first.nextOffset).toBe(32_000);
      await appendFile(
        path,
        jsonl(entry("later", "a2", "assistant", "same branch append", 5)),
      );
      runtime.setExternalSessionPresence(async (id) =>
        id === SESSION_ID ? ["later"] : [],
      );
      expect((await read(first.nextOffset!)).text).toBe(
        text.slice(32_000, 64_000),
      );
      expect((await runtime.branchImage(old, 1)).data.toString()).toBe("image");
      await appendFile(
        path,
        jsonl(
          entry("alt", "a1", "user", "alternative", 6),
          entry("alt-a", "alt", "assistant", "alternative answer", 7),
        ),
      );
      const active = (await runtime.snapshot(SESSION_ID)).active!;
      expect(active.effectiveLeafId).toBe("later");
      old = { ...old, viewId: active.transcriptPage.viewId };
      expect((await runtime.branchImage(old, 1)).data.toString()).toBe("image");
      const routes = await runtime.sessionHistory(SESSION_ID, old.viewId, {
        kind: "routes",
        parentId: "a1",
      });
      expect(routes.nodes.map(({ leafId }) => leafId)).toEqual([
        "later",
        "alt-a",
      ]);

      const watch = async (targetId: string) =>
        runtime.navigateBranch({
          sessionId: SESSION_ID,
          targetId,
          mode: "watch",
          revision: (await runtime.snapshot(SESSION_ID)).active!
            .branchRevision!,
        });
      const { snapshot } = await watch("alt-a");
      expect(snapshot.active).toMatchObject({ effectiveLeafId: "alt-a" });
      expect(snapshot.active?.readOnlyReason).toBeUndefined();
      await expect(read()).rejects.toMatchObject({ status: 409 });
      await expect(runtime.branchImage(old, 1)).rejects.toMatchObject({
        status: 409,
      });
      for (const control of [
        runtime.recoverPending.bind(runtime),
        runtime.abort.bind(runtime),
      ])
        await expect(control(SESSION_ID, old.viewId)).rejects.toMatchObject({
          code: "PENDING_VIEW_CHANGED",
        });

      expect((await watch("later")).snapshot.active).toMatchObject({
        effectiveLeafId: "later",
        readOnlyReason: "external-active",
      });
      expect(workers).toHaveLength(0);
    } finally {
      release();
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
        const tree = (await runtime.snapshot(SESSION_ID)).active!;
        await runtime.navigateBranch({
          sessionId: SESSION_ID,
          revision: tree.branchRevision!,
          targetId: target,
          mode: "switch",
        });
      }
      for (const id of ["foreign-one", "foreign-two"]) {
        await appendFile(
          path,
          jsonl(entry(id, foreignParent, "assistant", id, 60)),
        );
        const tree = (await runtime.snapshot(SESSION_ID)).active!;
        expect(tree.durableLeafId).toBe(id);
        expect(tree.effectiveLeafId).toBe(target);
        expect(worker.leafId).toBe(target);
        const snapshot = await runtime.snapshot(SESSION_ID);
        expect(snapshot.sessionStatuses[SESSION_ID]?.runState).not.toBe(
          "conflict",
        );
        expect(
          JSON.stringify(snapshot.active?.transcriptPage.messages),
        ).not.toContain(id);
      }
    },
  );
});
