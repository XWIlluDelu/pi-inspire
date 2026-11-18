import { readFileSync } from "node:fs";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PiRpcOptions, PiRpcProcess } from "../../server/pi-rpc.js";
import {
  RuntimeController,
  type RuntimeControllerOptions,
} from "../../server/runtime.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";
import { SessionCatalog } from "../../server/session-catalog.js";
import { stageSessionFork } from "../../server/session-fork.js";
import { SessionProjection } from "../../server/session-projection.js";
import type { BranchNavigateRequest } from "../../shared/contracts.js";
import {
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  fixtureWorkspace,
  initializeRuntimeFixture,
  startWorker,
  trackedAttachmentStore,
  trackRuntime,
} from "./fixtures/runtime.js";
import { jsonl, messageEntry } from "./fixtures/session-jsonl.js";

const id = "11111111-1111-4111-8111-111111111111";
const other = "33333333-3333-4333-8333-333333333333";
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
const faults = [
  "wrong-nonce",
  "malformed",
  "duplicate",
  "missing",
  "persist",
] as const;

/** Real JSONL and Catalog with one controllable Pi navigation reply. */
class BranchRpc extends FakeRpc {
  leafId: string | null;
  fault?: (typeof faults)[number];

  constructor(options: PiRpcOptions) {
    super(options);
    const [header, ...entries] = parseLines(
      readFileSync(this.sessionPath!, "utf8"),
    );
    this.sessionId = String(header!.id);
    this.leafId = (entries.at(-1)?.id as string | undefined) ?? null;
    this.responseOverrides.set(
      "get_entries",
      ({ since }: Record<string, unknown>) => {
        const index = entries.findIndex(({ id }) => id === since);
        if (since !== undefined && index < 0)
          throw new Error(`Entry not found: ${since}`);
        return { entries: entries.slice(index + 1), leafId: this.leafId };
      },
    );
    const {
      INSPIRE_BRANCH_COMMAND: command,
      INSPIRE_BRANCH_STATUS_KEY: statusKey,
      INSPIRE_BRANCH_WORKER_ID: workerId,
    } = options.env!;
    this.responseOverrides.set(
      "prompt",
      async ({ message }: Record<string, unknown>) => {
        if (typeof message !== "string" || !message.startsWith(`/${command} `))
          return {};
        const { nonce, targetId } = JSON.parse(
          Buffer.from(message.split(" ")[1]!, "base64url").toString(),
        );
        expect(["a1", "unfinished"]).toContain(targetId);
        const beforeLeaf = this.leafId;
        this.leafId = "a1";
        const result = {
          v: 1,
          sessionId: this.sessionId,
          ok: true,
          cancelled: false,
          beforeLeaf,
          nonce: this.fault === "wrong-nonce" ? "foreign" : nonce,
          workerId,
          effectiveLeaf: "a1",
          navigationLeaf: "a1",
        };
        if (this.fault === "persist") {
          const unexpected = entry(
            "unexpected",
            "a1",
            "assistant",
            "unexpected write",
            60,
          );
          this.leafId = unexpected.id;
          entries.push(unexpected);
          await appendFile(this.sessionPath!, jsonl(unexpected));
        }
        if (this.fault !== "missing") {
          const event = {
            type: "extension_ui_request",
            method: "setStatus",
            statusKey,
            statusText:
              this.fault === "malformed"
                ? "not+base64"
                : Buffer.from(JSON.stringify(result)).toString("base64url"),
          };
          this.emit("event", event);
          if (this.fault === "duplicate") this.emit("event", event);
        }
        return {};
      },
    );
  }

  override get available() {
    return this.stops === 0;
  }
  protected override checkpointLeaf() {
    return this.leafId;
  }
}

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

async function fixture({
  userContent = "second question",
  extra = [],
  external = false,
  cold = external,
  ...options
}: Pick<RuntimeControllerOptions, "openForkProjection" | "stageFork"> & {
  userContent?: Parameters<typeof entry>[3];
  extra?: ReturnType<typeof entry>[];
  external?: boolean;
  cold?: boolean;
} = {}) {
  const cwd = join(fixtureWorkspace, "workspace");
  const directory = join(fixtureWorkspace, "sessions");
  const path = join(directory, "session.jsonl");
  const timestamp = "2026-08-01T00:00:00.000Z";
  const header = { type: "session", version: 3, id, timestamp, cwd };
  const entries = [
    entry("u1", null, "user", "root", 1),
    entry("a1", "u1", "assistant", "first answer", 2),
    entry("u2", "a1", "user", userContent, 3),
    entry("a2", "u2", "assistant", "second answer", 4),
  ];
  const source = jsonl(header, ...entries, ...extra);
  await Promise.all([
    writeFile(path, source),
    writeFile(
      join(directory, "other.jsonl"),
      jsonl({ ...header, id: other }, ...entries),
    ),
  ]);
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
  let externalLeaf = "a2";
  if (external)
    runtime.setExternalSessionPresence(async (session) =>
      session === id ? [externalLeaf] : [],
    );
  await runtime.openSession(id);
  if (!cold) await startWorker(runtime, id);
  const snapshot = () => runtime.snapshot(id);
  const active = async () => (await snapshot()).active!;
  return {
    runtime,
    workers,
    worker: workers[0]!,
    path,
    directory,
    catalog,
    attachments,
    source,
    snapshot,
    active,
    reportExternal: (leaf: string) => {
      externalLeaf = leaf;
    },
    address: async (targetId = "u2") => ({
      sessionId: id,
      viewId: (await active()).transcriptPage.viewId,
      targetId,
    }),
    navigate: async (
      targetId: string,
      mode: BranchNavigateRequest["mode"] = "switch",
    ) =>
      runtime.navigateBranch({
        sessionId: id,
        revision: (await active()).branchRevision!,
        targetId,
        mode,
      }),
  };
}

it.each(["Stop", "exit"] as const)(
  "cannot renew a worker lease retired by %s during final reconciliation",
  async (retired) => {
    const f = await fixture();
    const entered = deferredSignal();
    const release = deferredSignal();
    const internal = f.runtime as unknown as {
      slots: Map<string, RuntimeSlot>;
    };
    const slot = internal.slots.get(id)!;
    const projection = slot.projection!;
    const reconcile = projection.reconcile.bind(projection);
    let held = false;
    vi.spyOn(projection, "reconcile").mockImplementation(async (force) => {
      const result = await reconcile(force);
      if (!held && f.worker.leafId === "a1") {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    const navigation = f.navigate("a1").catch((error: unknown) => error);
    try {
      await Promise.race([entered.promise, navigation]);
      expect(f.worker.leafId).toBe("a1");
      if (retired === "Stop") await f.runtime.abort(id);
      else f.worker.emit("exit", new Error("Branch worker exited"));
      expect(slot).toMatchObject({ process: null, pendingBranchBridge: null });
      release.resolve();
      expect(await navigation).toMatchObject({
        status: 409,
        message:
          "Branch navigation worker stopped before the result could be applied",
      });
      expect(await f.snapshot()).toMatchObject({
        sessionStatuses: {
          [id]: { runState: retired === "Stop" ? "aborted" : "failed" },
        },
        active: {
          durableLeafId: "a2",
          effectiveLeafId: "a2",
          restoreSavedLeafId: null,
        },
      });
      expect((await f.active()).transcriptPage.messages).toContainEqual(
        expect.objectContaining({ __inspireEntryId: "a2" }),
      );
      expect(slot.workerView).toBeNull();
      expect(await readFile(f.path, "utf8")).toBe(f.source);
      expect(f.workers).toHaveLength(1);
      expect(f.worker.stops).toBe(1);
    } finally {
      release.resolve();
      await navigation;
    }
  },
);

it.each(faults)(
  "stops the writer without replaying a %s navigation reply",
  async (fault) => {
    const f = await fixture();
    f.worker.fault = fault;
    await expect(f.navigate("a1")).rejects.toMatchObject({
      status: 504,
      outcomeUnknown: true,
    });
    expect(f.worker.stops).toBe(1);
    expect(
      f.worker.commands.filter(({ type }) => type === "prompt"),
    ).toHaveLength(1);
  },
);

it("fences a stale or invalid Fork source and retains selection made while waiting for admission", async () => {
  const stageFork = vi.fn(stageSessionFork);
  const f = await fixture({
    stageFork,
    extra: [
      entry("unfinished", "a1", "user", "Unanswered side branch", 5),
      entry("saved", "a2", "assistant", "Saved default", 6),
    ],
  });
  await f.runtime.openSession(other);
  const old = await f.address();
  for (const [override, message] of [
    [{ sessionId: "unknown-session" }, /not open on this host/],
    [{ viewId: "retired-view" }, /branch changed/],
    [{ targetId: "a1" }, /requires a retained user message/],
  ] as const)
    await expect(f.runtime.forkBranch({ ...old, ...override })).rejects.toThrow(
      message,
    );
  await expect(f.navigate("unfinished", "watch")).rejects.toThrow(
    /Use Edit from here/,
  );
  expect(f.worker.leafId).toBe("saved");
  expect(await f.navigate("unfinished", "edit")).toMatchObject({
    editorText: "Unanswered side branch",
    snapshot: { active: { effectiveLeafId: "a1" } },
  });
  await expect(f.runtime.forkBranch(old)).rejects.toThrow(/branch changed/);
  expect(f.runtime.startupSessionHint).toBe(other);

  const gate = deferredSignal();
  const entered = deferredSignal();
  const source = await f.address();
  f.worker.responseOverrides.set("set_auto_retry", () => {
    entered.resolve();
    return gate.promise;
  });
  const setting = f.runtime.setRuntimeSetting(id, {
    key: "autoRetryEnabled",
    value: false,
  });
  try {
    await Promise.race([entered.promise, setting]);
    const forking = f.runtime.forkBranch(source);
    await f.runtime.openSession(id);
    const leaf = (await f.active()).effectiveLeafId;
    gate.resolve();
    await setting;
    await forking;
    expect(stageFork).toHaveBeenCalledOnce();
    expect(f.runtime.startupSessionHint).toBe(id);
    expect((await f.active()).effectiveLeafId).toBe(leaf);
  } finally {
    gate.resolve();
    await setting;
  }
});

it("holds a published destination reservation and restages ordered duplicate images for the only new writer", async () => {
  const opened = deferredSignal();
  const release = deferredSignal();
  const extraImage = {
    ...image,
    data: Buffer.from("alternate image").toString("base64"),
    mimeType: "image/webp",
  };
  const images = [image, extraImage, image];
  let destination!: string;
  const f = await fixture({
    cold: true,
    userContent: images,
    async openForkProjection(record) {
      if (!record.path.includes(".inspire-fork-")) {
        destination = record.id;
        opened.resolve();
        await release.promise;
      }
      return SessionProjection.open(record);
    },
  });
  const forking = f.runtime.forkBranch(await f.address());
  try {
    await Promise.race([opened.promise, forking]);
    await f.catalog.refresh(true);
    expect((await f.catalog.get(destination))?.id).toBe(destination);
    const opening = f.runtime.openSession(destination);
    await f.runtime.openSession(id);
    release.resolve();
    const [forked, selected] = await Promise.all([forking, opening]);
    expect(forked.sessionId).toBe(destination);
    expect(selected.active?.sessionId).toBe(destination);
    expect(f.runtime.startupSessionHint).toBe(id);
    expect(f.workers).toHaveLength(0);
    expect(forked.editorText).toBe("");
    const uploads = forked.editorAttachments!;
    expect(new Set(uploads.map(({ id }) => id)).size).toBe(3);
    const bytes = await Promise.all(
      uploads.map(async ({ id, mimeType }) => ({
        mimeType,
        data: (await f.attachments.imagePreview(id)).bytes.toString("base64"),
        type: "image",
      })),
    );
    expect(bytes).toEqual(images);
    await f.attachments.remove(uploads[1]!.id);
    await expect(
      f.attachments.imagePreview(uploads[1]!.id),
    ).rejects.toMatchObject({ status: 404 });
    await f.runtime.prompt({
      sessionId: destination,
      message: "",
      attachmentIds: [uploads[0]!.id, uploads[2]!.id],
    });
    expect(f.workers.map(({ sessionId }) => sessionId)).toEqual([destination]);
    expect(
      f.workers[0]!.commands.find(({ type }) => type === "prompt"),
    ).toMatchObject({ message: "", images: [image, image] });
    expect(await readFile(f.path, "utf8")).toBe(f.source);
  } finally {
    release.resolve();
    await forking;
  }
});

it.each([
  "prefix rewrite",
  "destination collision",
  "final projection",
] as const)("preserves the Fork commit boundary after %s", async (failure) => {
  let staged!: Awaited<ReturnType<typeof stageSessionFork>>;
  const occupied = jsonl({
    type: "session",
    version: 3,
    id: "occupied",
    cwd: fixtureWorkspace,
    timestamp: new Date(0).toISOString(),
  });
  const f = await fixture({
    cold: true,
    userContent: [image],
    async stageFork(request) {
      if (failure === "prefix rewrite")
        await writeFile(
          f.path,
          f.source.replace("first answer", "other answer"),
        );
      staged = await stageSessionFork(request);
      if (failure === "destination collision")
        await writeFile(staged.destinationPath, occupied);
      return staged;
    },
    async openForkProjection(record) {
      if (
        failure === "final projection" &&
        record.path === staged.destinationPath
      )
        throw new Error("projection fixture failed");
      return SessionProjection.open(record);
    },
  });
  const images = vi.spyOn(f.attachments, "stageImages");
  const outcome = await f.runtime
    .forkBranch(await f.address())
    .catch((error: unknown) => error);
  expect(outcome).toMatchObject({
    status: 409,
    message: expect.stringContaining(
      failure === "prefix rewrite"
        ? "changed before its fork boundary"
        : failure === "destination collision"
          ? "destination already exists"
          : `Fork created Session ${staged.destinationId}`,
    ),
  });
  expect(
    (await readdir(f.directory)).filter((name) =>
      name.startsWith(".inspire-fork-"),
    ),
  ).toEqual([]);
  expect(f.workers).toHaveLength(0);
  if (failure === "prefix rewrite") {
    expect(images).not.toHaveBeenCalled();
    return;
  }
  const [abandoned] = await images.mock.results[0]!.value;
  await expect(f.attachments.imagePreview(abandoned!.id)).rejects.toMatchObject(
    { status: 404 },
  );
  const bytes = await readFile(staged.destinationPath, "utf8");
  if (failure === "destination collision") expect(bytes).toBe(occupied);
  else {
    expect(parseLines(bytes).at(-1)).toMatchObject({ id: "a1" });
    expect(
      (await f.runtime.openSession(staged.destinationId)).active?.sessionId,
    ).toBe(staged.destinationId);
  }
  expect(await readFile(f.path, "utf8")).toBe(f.source);
});

it("reads and copies the admitted external branch across appends, then retires its History and Pending address on Watch", async () => {
  const text = "Retained content. ".repeat(4000);
  const alternate = jsonl(
    entry("alt", "a1", "user", "alternative", 6),
    entry("alt-a", "alt", "assistant", "alternative answer", 7),
  );
  const partial = alternate.slice(0, 17);
  let writes = 0;
  const f = await fixture({
    external: true,
    userContent: [{ type: "text", text }, image],
    async stageFork(request) {
      if (writes++ === 0) await appendFile(request.sourcePath, partial);
      return stageSessionFork(request);
    },
  });
  const release = f.runtime.retainSessionView(id);
  try {
    const source = await f.address();
    const read = (offset?: number) =>
      f.runtime.sessionHistory(id, source.viewId, {
        kind: "entry",
        targetId: "u2",
        point: offset === undefined ? "1" : undefined,
        offset,
      });
    const first = await read();
    expect(first.node).toMatchObject({
      id: "u2",
      depth: 2,
      routeLeafId: "a2",
      active: true,
    });
    expect(first.nextOffset).toBe(32_000);
    await expect(f.navigate("u2", "edit")).rejects.toMatchObject({
      code: "EXTERNAL_PI_WRITER_ACTIVE",
    });
    const appended = jsonl(
      entry("later", "a2", "assistant", "same branch append", 5),
    );
    await appendFile(f.path, appended);
    f.reportExternal("later");
    expect((await read(first.nextOffset!)).text).toBe(
      text.slice(32_000, 64_000),
    );
    expect((await f.runtime.branchImage(source, 1)).data.toString()).toBe(
      "image",
    );
    const forked = await f.runtime.forkBranch(source);
    const cloned = await f.runtime.cloneBranch(source);
    for (const [copy, copiedIds] of [
      [forked, ["u1", "a1"]],
      [cloned, ["u1", "a1", "u2"]],
    ] as const) {
      const [header, ...entries] = parseLines(
        await readFile(copy.snapshot.active!.sessionFile!, "utf8"),
      );
      expect(header).toMatchObject({
        id: copy.sessionId,
        cwd: join(fixtureWorkspace, "workspace"),
        parentSession: f.path,
      });
      expect(entries.map(({ id }) => id)).toEqual(copiedIds);
      expect(copy.snapshot.active?.durableLeafId).toBe(copiedIds.at(-1));
    }
    expect(forked.editorText === text).toBe(true);
    expect(forked.editorAttachments).toHaveLength(1);
    expect(cloned.editorText).toBe("");
    expect(cloned.editorAttachments).toBeUndefined();
    expect(await readFile(f.path, "utf8")).toBe(f.source + appended + partial);
    await appendFile(f.path, alternate.slice(partial.length));
    expect(await f.active()).toMatchObject({
      effectiveLeafId: "later",
      readOnlyReason: "external-active",
    });
    const current = await f.address();
    const branches = await f.runtime.sessionHistory(id, current.viewId, {
      kind: "branches",
    });
    expect(branches.leaves).toMatchObject([
      { id: "alt-a", isCurrent: false },
      { id: "later", isCurrent: true },
    ]);
    const watched = await f.navigate("alt-a", "watch");
    expect(watched.snapshot.active?.effectiveLeafId).toBe("alt-a");
    expect(watched.snapshot.active?.readOnlyReason).toBeUndefined();
    await expect(
      f.runtime.sessionHistory(id, current.viewId, {
        kind: "entry",
        targetId: "u2",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(f.runtime.branchImage(current, 1)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      f.runtime.recoverPending(id, current.viewId),
    ).rejects.toMatchObject({ code: "PENDING_VIEW_CHANGED" });
    await expect(f.runtime.abort(id, current.viewId)).rejects.toMatchObject({
      code: "PENDING_VIEW_CHANGED",
    });
    expect((await f.navigate("later", "watch")).snapshot.active).toMatchObject({
      effectiveLeafId: "later",
      readOnlyReason: "external-active",
    });
    expect(f.workers).toHaveLength(0);
  } finally {
    release();
  }
}, 15_000);

it("does not offer to restore a normal saved append before the worker catches up", async () => {
  const f = await fixture();
  const before = await f.active();
  const parent = before.durableLeafId!;
  await appendFile(
    f.path,
    jsonl(entry("ahead", parent, "user", "next question", 55)),
  );
  expect(await f.active()).toMatchObject({
    durableLeafId: "ahead",
    effectiveLeafId: before.effectiveLeafId,
    restoreSavedLeafId: null,
  });
});

it("advances saved History without moving the selected worker branch", async () => {
  const f = await fixture();
  await f.navigate("a1");
  await appendFile(
    f.path,
    jsonl(entry("foreign", "a2", "assistant", "foreign", 60)),
  );
  const active = await f.active();
  expect(active).toMatchObject({
    durableLeafId: "foreign",
    effectiveLeafId: "a1",
    restoreSavedLeafId: "foreign",
  });
  expect(active.transcriptPage.messages).not.toContainEqual(
    expect.objectContaining({ __inspireEntryId: "foreign" }),
  );
  const restored = await f.navigate("foreign");
  expect(restored.snapshot.active).toMatchObject({
    effectiveLeafId: "foreign",
    restoreSavedLeafId: null,
  });
  expect(f.worker.stops).toBe(1);
});
