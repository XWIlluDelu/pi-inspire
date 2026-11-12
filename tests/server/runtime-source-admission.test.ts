import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelMetadataCatalog } from "../../server/model-metadata.js";
import { type PiRpcOptions, type PiRpcProcess } from "../../server/pi-rpc.js";

import { RuntimeController, safeProjection } from "../../server/runtime.js";

import { SessionCatalog } from "../../server/session-catalog.js";

import {
  catalog,
  disposeRuntimeFixture,
  FakeRpc,
  fixtureWorkspace,
  initializeRuntimeFixture,
  persistedRecord,
  preview,
  record,
  trackedAttachmentStore,
  trackRuntime,
  waitForReady,
  workspaceDirectories,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("runtime source admission", () => {
  it.each(["moved", "replaced", "removed", "ambiguous"] as const)(
    "refreshes a %s catalog source once before restoring read-only detail",
    async (change) => {
      const original = await persistedRecord("a");
      let discovered = [original];
      const list = vi.fn(async () => discovered);
      const source = new SessionCatalog(fixtureWorkspace, { list });
      await source.refresh();
      await mkdir(join(fixtureWorkspace, "moved"));
      const movedPath = join(fixtureWorkspace, "moved", "a.jsonl");
      await rename(original.path, movedPath);
      const replacement =
        change === "replaced" || change === "ambiguous"
          ? await persistedRecord("a")
          : { ...original, path: movedPath };
      discovered =
        change === "removed"
          ? []
          : change === "ambiguous"
            ? [replacement, { ...original, path: movedPath }]
            : [replacement];
      const createProcess = vi.fn(
        (options: PiRpcOptions) =>
          new FakeRpc(options) as unknown as PiRpcProcess,
      );
      const runtime = new RuntimeController(source, trackedAttachmentStore(), {
        createProcess,
      });
      trackRuntime(runtime);
      if (change === "removed") {
        await expect(runtime.snapshot("a")).rejects.toMatchObject({
          status: 404,
          code: "SESSION_NOT_FOUND",
        });
      } else if (change === "ambiguous") {
        await expect(runtime.openSession("a")).rejects.toMatchObject({
          status: 409,
        });
      } else {
        const snapshot = await runtime.snapshot("a");
        expect(snapshot.active?.sessionFile).toBe(replacement.path);
        expect(snapshot.active?.projectionHealth).toMatchObject({
          status: "ok",
        });
      }
      expect(list).toHaveBeenCalledTimes(2);
      expect(runtime.activeSessionId).toBeNull();
      expect(createProcess).not.toHaveBeenCalled();
      if (change === "moved" || change === "replaced") {
        await runtime.openSession("a");
        await waitForReady(runtime);
        expect(list).toHaveBeenCalledTimes(2);
        expect(createProcess).toHaveBeenCalledOnce();
      }
    },
  );

  it("does not loop when a refreshed catalog source is still stale", async () => {
    const session = await persistedRecord("a");
    await rename(session.path, `${session.path}.old`);
    await persistedRecord("a");
    const source = catalog([session]);
    const refresh = vi.spyOn(source, "refresh");
    const createProcess = vi.fn(
      (options: PiRpcOptions) =>
        new FakeRpc(options) as unknown as PiRpcProcess,
    );
    const runtime = new RuntimeController(source, trackedAttachmentStore(), {
      createProcess,
    });
    trackRuntime(runtime);
    await expect(runtime.openSession("a")).rejects.toMatchObject({
      code: "SESSION_CATALOG_STALE",
    });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
    expect(createProcess).not.toHaveBeenCalled();
    expect(runtime.activeSessionId).toBeNull();
  });

  it("reads retained history for unavailable workspaces and starts Pi only after an explicit reopen of the restored folder", async () => {
    const session = await persistedRecord(
      "a",
      join(fixtureWorkspace, "unavailable"),
    );
    const before = await readFile(session.path);
    const createProcess = vi.fn(
      (options: PiRpcOptions) =>
        new FakeRpc(options) as unknown as PiRpcProcess,
    );
    const queryModels = vi
      .fn()
      .mockRejectedValue(
        new Error("Metadata discovery must not run in an unavailable folder"),
      );
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      {
        createProcess,
      },
    );
    runtime.setModelMetadataCatalog(new ModelMetadataCatalog(queryModels));
    trackRuntime(runtime);
    const missing = await runtime.snapshot("a");
    expect(missing.active).toMatchObject({
      sessionId: "a",
      cwd: session.cwd,
      readOnlyReason: "workspace-unavailable",
      transcriptPage: {
        messages: [{ role: "user", content: "persisted:a" }],
      },
    });
    expect(runtime.activeSessionId).toBeNull();

    await writeFile(session.cwd, "not a directory");
    const opened = await runtime.openSession("a");
    expect(opened.active?.readOnlyReason).toBe("workspace-unavailable");
    const viewId = opened.active!.transcriptPage.viewId;
    const tree = await runtime.branchTree("a");
    expect(
      await runtime.branchEntry({ sessionId: "a", viewId, targetId: "u1" }),
    ).toMatchObject({
      text: "persisted:a",
    });
    const resources = await runtime.resourceContext("a");
    expect(await resources.loadMessages?.()).toContainEqual(
      expect.objectContaining({ role: "user", content: "persisted:a" }),
    );
    for (const operation of [
      () => runtime.prompt({ sessionId: "a", message: "do not execute" }),
      () => runtime.rename("a", "do not write"),
      () =>
        runtime.cloneBranch({
          sessionId: "a",
          viewId,
          targetId: tree.effectiveLeafId,
        }),
      () => runtime.nativeCommand({ sessionId: "a", command: "reload" }),
      () => runtime.refreshModels("a"),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        status: 409,
        code: "SESSION_WORKSPACE_UNAVAILABLE",
      });
    }
    expect(createProcess).not.toHaveBeenCalled();
    expect(queryModels).not.toHaveBeenCalled();
    expect(await readFile(session.path)).toEqual(before);

    await rm(session.cwd);
    await mkdir(session.cwd);
    const restored = await runtime.openSession("a");
    expect(restored.active?.readOnlyReason).toBeUndefined();
    expect(restored.active?.cwd).toBe(await realpath(session.cwd));
    expect(restored.active?.transcriptPage.viewId).not.toBe(viewId);
    await waitForReady(runtime);
    expect(createProcess).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cwd: await realpath(session.cwd) }),
    );
  });

  it("reconciles an injected scheduling projection before admitting a writer command", async () => {
    const session = record("a", "/tmp");
    const projection = await preview(session);
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      {
        createProcess: (options) => {
          worker = new FakeRpc(options);
          return worker as unknown as PiRpcProcess;
        },
        openSessionProjection: async () => projection,
      },
    );
    trackRuntime(runtime);
    await runtime.openSession("a");
    await waitForReady(runtime);
    const reconcile = vi
      .spyOn(projection, "reconcile")
      .mockRejectedValueOnce(new Error("pre-write reconciliation failed"));
    await expect(
      runtime.prompt({ sessionId: "a", message: "must not write" }),
    ).rejects.toThrow("pre-write reconciliation failed");
    expect(reconcile).toHaveBeenCalledWith(true);
    expect(worker.commands.some((command) => command.type === "prompt")).toBe(
      false,
    );
  });

  it.runIf(process.platform !== "win32")(
    "freezes one physical workspace root before starting slot-owned operations",
    async () => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "inspire-runtime-workspace-")),
      );
      workspaceDirectories.push(root);
      const physicalOne = join(root, "one");
      const physicalTwo = join(root, "two");
      const alias = join(root, "selected");
      await mkdir(physicalOne);
      await mkdir(physicalTwo);
      await writeFile(join(physicalOne, "marker.txt"), "one");
      await writeFile(join(physicalTwo, "marker.txt"), "two");
      await symlink(physicalOne, alias, "dir");
      const sessionPath = join(root, "a.jsonl");
      const session = record("a", alias);
      session.path = sessionPath;
      await writeFile(
        sessionPath,
        `${JSON.stringify({ type: "session", version: 3, id: "a", timestamp: new Date().toISOString(), cwd: alias })}\n${JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hello", timestamp: 1 } })}\n`,
      );
      const store = trackedAttachmentStore();
      let worker: FakeRpc | undefined;
      const runtime = new RuntimeController(catalog([session]), store, {
        createProcess: (options) => {
          worker = new FakeRpc(options);
          return worker as unknown as PiRpcProcess;
        },
      });
      trackRuntime(runtime);
      const initial = await runtime.openSession("a");
      const physical = await realpath(alias);
      await vi.waitFor(() => expect(worker?.starts).toBe(1));
      expect(physical).toBe(physicalOne);
      expect(worker?.options.cwd).toBe(physicalOne);
      expect(initial.active?.cwd).toBe(physicalOne);
      expect(runtime.sessionCwd("a")).toBe(physicalOne);

      await rm(alias);
      await symlink(physicalTwo, alias, "dir");
      await runtime.prompt({
        sessionId: "a",
        message: "use marker",
        projectFiles: ["marker.txt"],
      });
      const prompt = worker?.commands.find(
        (command) => command.type === "prompt",
      );
      expect(prompt?.message).toContain(join(physicalOne, "marker.txt"));
      expect(prompt?.message).not.toContain(join(physicalTwo, "marker.txt"));
      expect((await runtime.resourceContext("a")).cwd).toBe(physicalOne);
    },
  );

  it("redacts credential-shaped fields and bounds oversized values", () => {
    const projected = safeProjection({
      authorization: "Bearer secret",
      nested: { apiKey: "secret", message: "x".repeat(250_001) },
      items: Array.from({ length: 10_001 }, (_, index) => index),
    }) as Record<string, unknown>;

    expect(projected.authorization).toBe("[redacted]");
    expect((projected.nested as Record<string, unknown>).apiKey).toBe(
      "[redacted]",
    );
    expect(
      String((projected.nested as Record<string, unknown>).message).endsWith(
        "…[truncated]",
      ),
    ).toBe(true);
    expect(projected.items).toHaveLength(10_000);
  });
});
