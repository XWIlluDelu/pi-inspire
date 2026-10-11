import { writeFile } from "node:fs/promises";

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type PiRpcProcess } from "../../server/pi-rpc.js";
import { ResourceStore } from "../../server/resources.js";
import {
  RuntimeController,
  type RuntimeWorkerStatus,
} from "../../server/runtime.js";

import { PreviewProjection } from "./fixtures/preview-projection.js";
import {
  catalog,
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  fixtureCwd,
  initializeRuntimeFixture,
  preview,
  previewSnapshot,
  record,
  trackedAttachmentStore,
  waitForReady,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("session selection and addressed reads", () => {
  it("delivers addressed writes to their named session, not the current selection", async () => {
    const store = trackedAttachmentStore();
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    await runtime.openSession("a");
    await runtime.openSession("b");

    // Selection is b; writes addressed to a still land on a's worker.
    await runtime.prompt({ sessionId: "a", message: "background instruction" });
    await runtime.rename("a", "renamed A");
    const workerA = workers.find((worker) => worker.sessionId === "a")!;
    const workerB = workers.find((worker) => worker.sessionId === "b")!;
    expect(
      workerA.commands.some(
        (command) =>
          command.type === "prompt" &&
          command.message === "background instruction",
      ),
    ).toBe(true);
    expect(
      workerA.commands.some(
        (command) =>
          command.type === "set_session_name" && command.name === "renamed A",
      ),
    ).toBe(true);
    expect(workers.map((worker) => worker.sessionId)).toEqual(["a", "b"]);
    expect(
      workerB.commands.filter((command) =>
        ["prompt", "set_session_name"].includes(String(command.type)),
      ),
    ).toEqual([]);
    expect(runtime.activeSessionId).toBe("b");
    await runtime.close();
  });

  it("keeps the newest selection when an earlier open completes late", async () => {
    const store = trackedAttachmentStore();
    const { promise: gateA, resolve: releaseA } = deferredSignal();
    const runtime = new RuntimeController(
      catalog([record("a", "/project"), record("b", "/project")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      async (session) => {
        if (session.id === "a") await gateA;
        return preview(session);
      },
    );
    const openingA = runtime.openSession("a");
    const openedB = await runtime.openSession("b");
    expect(openedB.active?.sessionId).toBe("b");
    releaseA();
    const openedA = await openingA;
    // The slower A open answers its own caller without stealing B's selection.
    expect(openedA.active?.sessionId).toBe("a");
    expect(openedA.active?.transcriptPage.messages).toEqual([
      { role: "user", content: "preview:a", timestamp: 1 },
    ]);
    expect(runtime.activeSessionId).toBe("b");
    expect((await runtime.snapshot()).active?.sessionId).toBe("b");
    await runtime.close();
  });

  it("does not change selection when a ready session's pre-commit snapshot fails", async () => {
    const store = trackedAttachmentStore();
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/project"), record("b", "/project")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    await runtime.openSession("a");
    const slots = (
      runtime as unknown as { slots: Map<string, { ready: boolean }> }
    ).slots;
    await vi.waitFor(() => expect(slots.get("a")?.ready).toBe(true));
    await runtime.openSession("b");

    const workerA = workers.find((worker) => worker.sessionId === "a")!;
    const request = workerA.request.bind(workerA);
    workerA.request = async <T>(
      command: Record<string, unknown>,
    ): Promise<T> => {
      if (command.type === "get_state")
        throw new Error("snapshot failed before selection");
      return request<T>(command);
    };

    await expect(runtime.openSession("a")).rejects.toThrow(
      /snapshot failed before selection/,
    );
    expect(runtime.activeSessionId).toBe("b");
    await runtime.close();
  });

  it.each([undefined, "a"])(
    "keeps snapshot interest %s independent of concurrent Host selection",
    async (interest) => {
      const store = trackedAttachmentStore();
      const workers: FakeRpc[] = [];
      const runtime = new RuntimeController(
        catalog([record("a", "/project"), record("b", "/project")]),
        store,
        (options) => {
          const worker = new FakeRpc(options);
          workers.push(worker);
          return worker as unknown as PiRpcProcess;
        },
        preview,
      );
      const restored = await runtime.snapshot("a");
      expect(restored.active?.sessionId).toBe("a");
      expect(runtime.activeSessionId).toBeNull();
      expect(workers).toHaveLength(0);
      await runtime.openSession("a");
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));

      const { promise: gate, resolve: releaseSnapshot } = deferredSignal();
      const { promise: started, resolve: snapshotStarted } = deferredSignal();
      const workerA = workers[0]!;
      const request = workerA.request.bind(workerA);
      workerA.request = async <T>(
        command: Record<string, unknown>,
      ): Promise<T> => {
        if (command.type === "get_state") {
          snapshotStarted();
          await gate;
        }
        return request<T>(command);
      };

      const snapshotting = runtime.snapshot(interest);
      await started;
      await runtime.openSession("b");
      releaseSnapshot();

      const snapshot = await snapshotting;
      expect(snapshot.active?.sessionId).toBe(interest ?? "b");
      const globalOnly = await runtime.snapshot(null);
      expect(globalOnly.active).toBeNull();
      expect(Object.keys(globalOnly.sessionStatuses).sort()).toEqual([
        "a",
        "b",
      ]);
      expect(runtime.activeSessionId).toBe("b");
      await runtime.close();
    },
  );

  it("publishes and restores needs-input status for an independently observed worker", async () => {
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/project"), record("b", "/project")]),
      trackedAttachmentStore(),
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      await runtime.openSession("a");
      await new Promise<void>((resolveTick) => setImmediate(resolveTick));
      await runtime.openSession("b");
      const events: Array<Record<string, unknown>> = [];
      const workerStatuses: RuntimeWorkerStatus[] = [];
      runtime.on("event", (event) => events.push(event));
      runtime.on("worker_status", (rpc, status) => {
        if (rpc === workers[0]) workerStatuses.push(status);
      });
      workers[0]!.emit("event", {
        type: "extension_ui_request",
        id: "needs-answer",
        method: "confirm",
        title: "Proceed?",
      });
      expect(events.at(-1)?.sessionStatus).toMatchObject({
        needsInput: true,
        indicator: "attention",
      });
      const snapshot = await runtime.snapshot("a");
      expect(snapshot.sessionStatuses.a?.needsInput).toBe(true);
      expect(snapshot.pendingExtensionUiRequests?.[0]?.id).toBe("needs-answer");
      expect(workerStatuses.at(-1)).toEqual({
        sessionId: "a",
        runState: "idle",
        needsInput: true,
      });
      await runtime.extensionUiResponse({
        sessionId: "a",
        id: "needs-answer",
        confirmed: true,
      });
      expect(
        (await runtime.snapshot("a")).sessionStatuses.a?.needsInput,
      ).toBeUndefined();
      expect(workerStatuses.at(-1)).toEqual({
        sessionId: "a",
        runState: "idle",
        needsInput: false,
      });
      expect(runtime.activeSessionId).toBe("b");
    } finally {
      await runtime.close();
    }
  });

  it("keeps addressed resources readable while another browser selects a different session", async () => {
    const project = fixtureCwd("/project");
    await writeFile(join(project, "report.md"), "report bytes");
    const resources = new ResourceStore();
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", project), record("b", "/other")]),
      trackedAttachmentStore(),
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      async (session) => {
        const snapshot = await previewSnapshot(session);
        snapshot.transcriptPage.messages = [
          {
            role: "user",
            content: [
              { type: "text", text: "[report](report.md)" },
              {
                type: "image",
                mimeType: "image/png",
                data: Buffer.from("pixels").toString("base64"),
              },
            ],
          },
        ];
        return new PreviewProjection(session.id, snapshot);
      },
    );
    try {
      await runtime.openSession("a");
      await waitForReady(runtime, "a");
      const pendingContext = await runtime.resourceContext("a");
      await runtime.openSession("b");
      await waitForReady(runtime, "b");
      await expect(pendingContext.loadMessages!()).resolves.toHaveLength(1);
      await expect(pendingContext.loadMessages!()).resolves.toHaveLength(1);
      expect(
        workers
          .flatMap((worker) => worker.commands)
          .some((command) => command.type === "get_messages"),
      ).toBe(false);
      expect((await runtime.snapshot("a")).active?.sessionId).toBe("a");
      const context = await runtime.resourceContext("a");
      expect((await resources.list(context)).resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reference: "report.md" }),
          expect.objectContaining({ reference: "pi-embedded://0/1" }),
        ]),
      );
      await expect(resources.probe(context, ["report.md"])).resolves.toEqual([
        {
          reference: "report.md",
          availability: "available",
          workspacePath: "report.md",
        },
      ]);
      const file = await resources.resolve(context, "report.md");
      const resource = resources.get(file.id, "a", context.viewId);
      await resources.revalidate(resource, context);
      const opened = await resources.openForServing(resource);
      try {
        expect(await opened.handle.readFile("utf8")).toBe("report bytes");
      } finally {
        await opened.handle.close();
      }
      const image = await resources.resolve(context, "pi-embedded://0/1");
      expect(
        (
          await resources.embeddedContent(
            resources.get(image.id, "a", context.viewId),
            context,
          )
        ).data.toString(),
      ).toBe("pixels");
      expect(runtime.activeSessionId).toBe("b");
      expect(() => resources.get(file.id, "b", context.viewId)).toThrow(
        "no longer available",
      );
    } finally {
      await resources.close();
      await runtime.close();
    }
  });

  it("single-flights concurrent opens of the same session", async () => {
    const store = trackedAttachmentStore();
    const { promise: previewGate, resolve: releasePreview } = deferredSignal();
    let previewCalls = 0;
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      async (session) => {
        previewCalls += 1;
        await previewGate;
        return preview(session);
      },
    );

    const first = runtime.openSession("a");
    const second = runtime.openSession("a");
    await vi.waitFor(() => expect(previewCalls).toBe(1));
    releasePreview();
    await Promise.all([first, second]);
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(workers).toHaveLength(1);
    expect(workers[0]!.starts).toBe(1);

    await runtime.close();
    expect(workers[0]!.stops).toBe(1);
  });

  it("keeps one independent worker per opened session and never stops one during view changes", async () => {
    const store = trackedAttachmentStore();
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([
        record("a", "/project/one"),
        record("b", "/project/one"),
        record("c", "/project/two"),
      ]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );

    await runtime.openSession("a");
    await runtime.openSession("b");
    await runtime.openSession("c");
    await waitForReady(runtime, "c");
    expect(workers).toHaveLength(3);
    expect(workers.map((worker) => worker.options.cwd)).toEqual([
      fixtureCwd("/project/one"),
      fixtureCwd("/project/one"),
      fixtureCwd("/project/two"),
    ]);
    expect(workers.every((worker) => worker.stops === 0)).toBe(true);

    await runtime.openSession("a");
    expect(workers).toHaveLength(3);
    expect(workers.every((worker) => worker.stops === 0)).toBe(true);

    await runtime.close();
    expect(workers.every((worker) => worker.stops === 1)).toBe(true);
  });

  it("derives background conflict indicators after selection changes", async () => {
    const store = trackedAttachmentStore();
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
    );
    type InternalSlot = {
      conflict: {
        kind: "external-change" | "projection-failure";
        message: string;
        revision: number;
      } | null;
      runState: string;
      attention: "completed" | "failed" | null;
    };
    const slots = (runtime as unknown as { slots: Map<string, InternalSlot> })
      .slots;
    try {
      await runtime.openSession("a");
      const a = slots.get("a")!;
      a.conflict = {
        kind: "external-change",
        message: "external update",
        revision: 2,
      };
      a.runState = "conflict";
      a.attention = null;
      expect((await runtime.snapshot()).sessionStatuses.a).toEqual({
        runState: "conflict",
      });

      const selectedB = await runtime.openSession("b");
      expect(selectedB.sessionStatuses.a).toEqual({
        runState: "conflict",
        indicator: "attention",
      });

      a.conflict = {
        kind: "projection-failure",
        message: "damaged projection",
        revision: 3,
      };
      expect((await runtime.snapshot()).sessionStatuses.a).toEqual({
        runState: "conflict",
        indicator: "failed",
      });
    } finally {
      await runtime.close();
    }
  });

  it("publishes running and unseen completion state, then acknowledges it when viewed", async () => {
    const store = trackedAttachmentStore();
    const workers: FakeRpc[] = [];
    const events: Array<Record<string, unknown>> = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/project"), record("b", "/project")]),
      store,
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    runtime.on("event", (event) =>
      events.push(event as Record<string, unknown>),
    );

    await runtime.openSession("a");
    await runtime.openSession("b");
    workers[0]!.emit("event", { type: "agent_start" });
    expect((await runtime.snapshot()).sessionStatuses.a).toEqual({
      runState: "running",
      indicator: "running",
    });

    workers[0]!.emit("event", { type: "agent_settled" });
    await vi.waitFor(async () => {
      expect((await runtime.snapshot()).sessionStatuses.a).toEqual({
        runState: "idle",
        indicator: "completed",
      });
    });
    expect(
      events.findLast((event) => event.type === "agent_settled"),
    ).toMatchObject({
      type: "agent_settled",
      sessionId: "a",
      sessionStatus: { indicator: "completed" },
    });

    await runtime.openSession("a");
    expect((await runtime.snapshot()).sessionStatuses.a).toEqual({
      runState: "idle",
    });

    workers[1]!.emit("event", { type: "agent_start" });
    workers[1]!.emit("event", {
      type: "message_end",
      message: { role: "assistant", stopReason: "error" },
    });
    workers[1]!.emit("event", { type: "agent_settled" });
    expect((await runtime.snapshot()).sessionStatuses.b).toEqual({
      runState: "failed",
      indicator: "failed",
    });

    workers[0]!.emit("event", { type: "agent_start" });
    workers[0]!.emit("event", {
      type: "message_end",
      message: { role: "assistant", stopReason: "length" },
    });
    workers[0]!.emit("event", { type: "agent_settled" });
    expect((await runtime.snapshot()).sessionStatuses.a).toEqual({
      runState: "failed",
    });

    await runtime.openSession("b");
    expect((await runtime.snapshot()).sessionStatuses.b).toEqual({
      runState: "failed",
    });
    await runtime.close();
  });
});
