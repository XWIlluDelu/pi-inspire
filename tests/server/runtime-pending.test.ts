import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import {
  FakeRpc,
  record,
  waitForReady,
  preview,
  catalog,
  trackedAttachmentStore,
  deferredSignal,
  upload,
  initializeRuntimeFixture,
  disposeRuntimeFixture,
} from "./fixtures/runtime.js";

function pendingEntry(id: string, text: string) {
  return {
    id,
    textPreview: text,
    textLength: text.length,
    textTruncated: false,
  };
}

async function queuedImageFixture() {
  const store = trackedAttachmentStore();
  const queue = { steering: [] as string[], followUp: [] as string[] };
  let worker!: FakeRpc;
  const runtime = new RuntimeController(
    catalog([record("a", "/tmp")]),
    store,
    (options) => {
      worker = new FakeRpc(options);
      queue.steering = [];
      queue.followUp = [];
      worker.responseOverrides.set(
        "prompt",
        (command: Record<string, unknown>) => {
          if (command.streamingBehavior) {
            const texts =
              command.streamingBehavior === "steer"
                ? queue.steering
                : queue.followUp;
            texts.push(String(command.message));
            worker.emit("event", {
              type: "queue_update",
              ...structuredClone(queue),
            });
          }
          return {};
        },
      );
      worker.responseOverrides.set("clear_queue", () => {
        const result = structuredClone(queue);
        queue.steering = [];
        queue.followUp = [];
        worker.emit("event", { type: "queue_update", ...queue });
        return result;
      });
      return worker as unknown as PiRpcProcess;
    },
    preview,
  );
  await runtime.openSession("a");
  await waitForReady(runtime);
  worker.emit("event", { type: "agent_start" });
  return {
    runtime,
    store,
    queue,
    get worker() {
      return worker;
    },
  };
}

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("RuntimeController Pending input and recovery", () => {
  it("keeps observed pending input across reconnect and settlement, clearing it only on queue removal or worker replacement", async () => {
    const store = trackedAttachmentStore();
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    await runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));

    const initialRevision = (await runtime.snapshot()).pendingQueues!.revision;
    const longPendingText = "x".repeat(600);
    worker.emit("event", {
      type: "queue_update",
      steering: ["first", longPendingText],
      followUp: ["later"],
    });
    expect((await runtime.snapshot()).pendingQueues).toEqual({
      totalCount: 3,
      revision: initialRevision + 1,
      steering: [
        pendingEntry("text-steer-0", "first"),
        {
          ...pendingEntry(
            "text-steer-1",
            `${"x".repeat(384)}\n…\n${"x".repeat(125)}`,
          ),
          textLength: 600,
          textTruncated: true,
        },
      ],
      followUp: [pendingEntry("text-followUp-0", "later")],
    });

    worker.emit("event", {
      type: "queue_update",
      steering: Array.from({ length: 1_001 }, (_, index) => `steer-${index}`),
      followUp: ["bounded-out"],
    });
    expect((await runtime.snapshot()).pendingQueues).toMatchObject({
      totalCount: 1_002,
      revision: initialRevision + 2,
      steering: { length: 1_000 },
      followUp: [],
    });

    worker.emit("event", { type: "agent_settled" });
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).pendingQueues).toMatchObject({
        totalCount: 1_002,
        revision: initialRevision + 3,
        steering: { length: 1_000 },
        followUp: [],
      }),
    );

    worker.emit("event", {
      type: "queue_update",
      steering: ["stale"],
      followUp: [],
    });
    const beforeReplacement = (await runtime.snapshot()).pendingQueues!
      .revision;
    worker.emit("exit", new Error("replacement required"));
    const replaced = (await runtime.snapshot()).pendingQueues!;
    expect(replaced).toMatchObject({
      totalCount: 0,
      steering: [],
      followUp: [],
    });
    expect(replaced.revision).toBeGreaterThan(beforeReplacement);
    await runtime.close();
  });

  it("holds manual-compaction input as Pending, clears it, and starts the first surviving prompt once Pi is idle", async () => {
    let worker!: FakeRpc;
    const compactGate = deferredSignal();
    let streaming = false;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      worker.responseOverrides.set("compact", () => compactGate.promise);
      worker.responseOverrides.set("get_state", () => ({
        sessionId: "a",
        sessionFile: worker.sessionPath,
        isStreaming: streaming,
        isCompacting: false,
        thinkingLevel: "medium",
        model: { provider: "test", id: "model" },
      }));
      worker.responseOverrides.set("prompt", () => {
        streaming = true;
        return {};
      });
      const compact = runtime.nativeCommand({
        sessionId: "a",
        command: "compact",
      });
      await vi.waitFor(() =>
        expect(
          worker.commands.some((command) => command.type === "compact"),
        ).toBe(true),
      );
      const removed = runtime.prompt({
        sessionId: "a",
        message: "remove me",
        behavior: "steer",
      });
      await vi.waitFor(async () =>
        expect((await runtime.snapshot()).pendingQueues?.totalCount).toBe(1),
      );
      await runtime.clearPending("a");
      await expect(removed).rejects.toMatchObject({ code: "PROMPT_CLEARED" });
      const first = runtime.prompt({
        sessionId: "a",
        message: "start",
        behavior: "steer",
      });
      const second = runtime.prompt({
        sessionId: "a",
        message: "later",
        behavior: "followUp",
      });
      await vi.waitFor(async () =>
        expect((await runtime.snapshot()).pendingQueues?.totalCount).toBe(2),
      );
      expect(
        worker.commands.filter((command) => command.type === "prompt"),
      ).toEqual([]);
      worker.emit("event", {
        type: "compaction_end",
        reason: "manual",
        result: {},
      });
      compactGate.resolve();
      await compact;
      await Promise.all([first, second]);
      expect(
        worker.commands.filter((command) => command.type === "prompt"),
      ).toMatchObject([
        { message: "start" },
        { message: "later", streamingBehavior: "followUp" },
      ]);
    } finally {
      compactGate.resolve();
      await runtime.close();
    }
  });

  it("does not overtake the original prompt while auto-compaction runs in preflight", async () => {
    let worker!: FakeRpc;
    const firstGate = deferredSignal();
    let streaming = false;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      worker.responseOverrides.set(
        "prompt",
        (command: Record<string, unknown>) =>
          command.message === "first" ? firstGate.promise : {},
      );
      worker.responseOverrides.set("get_state", () => ({
        sessionId: "a",
        sessionFile: worker.sessionPath,
        isStreaming: streaming,
        isCompacting: false,
      }));
      const first = runtime.prompt({ sessionId: "a", message: "first" });
      await vi.waitFor(() =>
        expect(
          worker.commands.some((command) => command.type === "prompt"),
        ).toBe(true),
      );
      worker.emit("event", { type: "compaction_start", reason: "threshold" });
      const queued = runtime.prompt({
        sessionId: "a",
        message: "follow",
        behavior: "followUp",
      });
      await vi.waitFor(async () =>
        expect((await runtime.snapshot()).pendingQueues?.totalCount).toBe(1),
      );
      worker.emit("event", {
        type: "compaction_end",
        reason: "threshold",
        result: {},
      });
      await new Promise<void>((done) => setImmediate(done));
      expect(
        worker.commands.filter((command) => command.type === "prompt"),
      ).toHaveLength(1);
      streaming = true;
      firstGate.resolve();
      await Promise.all([first, queued]);
      expect(
        worker.commands.filter((command) => command.type === "prompt"),
      ).toMatchObject([
        { message: "first" },
        { message: "follow", streamingBehavior: "followUp" },
      ]);
    } finally {
      firstGate.resolve();
      await runtime.close();
    }
  });

  it("lets queued input and Clear bypass a blocked extension receipt", async () => {
    let worker!: FakeRpc;
    const extensionGate = deferredSignal();
    const steeringGate = deferredSignal();
    let streaming = false;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        worker = new FakeRpc(options);
        worker.responseOverrides.set("get_commands", () => ({
          commands: [{ name: "slow", source: "extension" }],
        }));
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      await runtime.snapshot();
      worker.responseOverrides.set("get_state", () => ({
        sessionId: "a",
        sessionFile: worker.sessionPath,
        isStreaming: streaming,
        isCompacting: false,
      }));
      worker.responseOverrides.set(
        "prompt",
        (command: Record<string, unknown>) =>
          command.message === "/slow"
            ? extensionGate.promise
            : command.message === "live"
              ? steeringGate.promise
              : {},
      );
      const extension = runtime.prompt({ sessionId: "a", message: "/slow" });
      await vi.waitFor(() =>
        expect(
          worker.commands.some((command) => command.type === "prompt"),
        ).toBe(true),
      );
      const queued = runtime.prompt({
        sessionId: "a",
        message: "direction",
        behavior: "steer",
      });
      await vi.waitFor(async () =>
        expect((await runtime.snapshot()).pendingQueues?.totalCount).toBe(1),
      );
      await runtime.clearPending("a");
      await expect(queued).rejects.toMatchObject({ code: "PROMPT_CLEARED" });
      expect(
        worker.commands.filter((command) => command.type === "prompt"),
      ).toHaveLength(1);
      const steering = runtime.prompt({
        sessionId: "a",
        message: "live",
        behavior: "steer",
      });
      const following = runtime.prompt({
        sessionId: "a",
        message: "more",
        behavior: "followUp",
      });
      await vi.waitFor(async () =>
        expect((await runtime.snapshot()).pendingQueues?.totalCount).toBe(2),
      );
      streaming = true;
      worker.emit("event", { type: "agent_start" });
      await vi.waitFor(() =>
        expect(
          worker.commands.some((command) => command.message === "more"),
        ).toBe(true),
      );
      expect(
        worker.commands.filter((command) => command.type === "prompt"),
      ).toMatchObject([
        { message: "/slow" },
        { message: "live", streamingBehavior: "steer" },
        { message: "more", streamingBehavior: "followUp" },
      ]);
      steeringGate.resolve();
      await Promise.all([steering, following]);
      extensionGate.resolve();
      await extension;
    } finally {
      steeringGate.resolve();
      extensionGate.resolve();
      await runtime.close();
    }
  });

  it("does not make a slow steer receipt block the next steer or Clear", async () => {
    let worker!: FakeRpc;
    const slowGate = deferredSignal();
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      worker.emit("event", { type: "agent_start" });
      worker.responseOverrides.set(
        "prompt",
        (command: Record<string, unknown>) =>
          command.message === "slow" ? slowGate.promise : {},
      );
      const slow = runtime.prompt({
        sessionId: "a",
        message: "slow",
        behavior: "steer",
      });
      await vi.waitFor(() =>
        expect(
          worker.commands.some((command) => command.message === "slow"),
        ).toBe(true),
      );
      const next = runtime.prompt({
        sessionId: "a",
        message: "next",
        behavior: "followUp",
      });
      await runtime.clearPending("a");
      await vi.waitFor(() =>
        expect(
          worker.commands.some((command) => command.message === "next"),
        ).toBe(true),
      );
      slowGate.resolve();
      await Promise.all([slow, next]);
    } finally {
      slowGate.resolve();
      await runtime.close();
    }
  });

  it("copies full pending text beyond display limits without mutating queues", async () => {
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      const longText = `${"x".repeat(70_000)}END\n`;
      const steering = [
        longText,
        ...Array.from({ length: 1001 }, (_, index) => `steer-${index}`),
      ];
      worker.emit("event", {
        type: "queue_update",
        steering,
        followUp: ["hidden follow"],
      });
      const snapshot = await runtime.snapshot();
      const request = {
        sessionId: "a",
        viewId: snapshot.active!.transcriptPage.viewId,
        revision: snapshot.pendingQueues!.revision,
      };
      expect(snapshot.pendingQueues!.steering).toHaveLength(1000);
      await expect(
        runtime.pendingText({ ...request, itemId: "text-steer-0" }),
      ).resolves.toBe(longText);
      const all = await runtime.pendingText(request);
      expect(all).toContain(longText.replace(/\n/g, "\n   "));
      expect(all).toContain("1003. hidden follow");
      expect((await runtime.snapshot()).pendingQueues).toEqual(
        snapshot.pendingQueues,
      );
      expect(
        worker.commands.some(
          ({ type }) => type === "clear_queue" || type === "abort",
        ),
      ).toBe(false);
      worker.emit("event", {
        type: "queue_update",
        steering: steering.slice(1),
        followUp: ["hidden follow"],
      });
      await expect(
        runtime.pendingText({ ...request, itemId: "text-steer-0" }),
      ).rejects.toThrow("Pending input changed");
      const settled = new Promise<void>((resolveSettled) =>
        runtime.on("event", (event) => {
          if (event.type === "agent_settled") resolveSettled();
        }),
      );
      worker.emit("event", { type: "agent_settled", messages: [] });
      await settled;
      for (let index = 0; index < request.revision; index++)
        worker.emit("event", {
          type: "queue_update",
          steering: ["different run, same coordinate"],
          followUp: [],
        });
      await expect(
        runtime.pendingText({ ...request, itemId: "text-steer-0" }),
      ).rejects.toThrow("Pending input changed");
      worker.emit("event", {
        type: "queue_update",
        steering: ["preview"],
        followUp: [42],
      });
      const changed = await runtime.snapshot();
      await expect(
        runtime.pendingText({
          ...request,
          revision: changed.pendingQueues!.revision,
        }),
      ).rejects.toThrow("Complete pending text is unavailable");
    } finally {
      await runtime.close();
    }
  });

  it("does not make dequeue wait behind a suspended pre-prompt hook", async () => {
    let worker!: FakeRpc;
    const hook = deferredSignal();
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    let sending: Promise<unknown> | undefined;
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      worker.responseOverrides.set("prompt", () => hook.promise);
      sending = runtime
        .prompt({ sessionId: "a", message: "suspended hook" })
        .catch((error: unknown) => error);
      await vi.waitFor(() =>
        expect(worker.commands.some(({ type }) => type === "prompt")).toBe(
          true,
        ),
      );
      const recovering = runtime.recoverPending("a");
      await vi.waitFor(() =>
        expect(worker.commands.some(({ type }) => type === "clear_queue")).toBe(
          true,
        ),
      );
      await expect(recovering).resolves.toEqual({ steering: [], followUp: [] });
    } finally {
      hook.resolve();
      await sending;
      await runtime.close();
    }
  });

  it("recovers only unconsumed Pi texts, all Steer before Queue, without stopping", async () => {
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      worker.emit("event", { type: "agent_start" });
      worker.emit("event", {
        type: "queue_update",
        steering: ["consumed", "left"],
        followUp: ["later"],
      });
      worker.responseOverrides.set("clear_queue", () => {
        worker.emit("event", {
          type: "queue_update",
          steering: [],
          followUp: [],
        });
        return { steering: ["left"], followUp: ["later"] };
      });
      await expect(runtime.recoverPending("a")).resolves.toEqual({
        steering: ["left"],
        followUp: ["later"],
      });
      expect((await runtime.snapshot()).pendingQueues!.totalCount).toBe(0);
      expect((await runtime.snapshot()).runState).toBe("running");
      expect(worker.stops).toBe(0);
      expect(worker.commands.some(({ type }) => type === "abort")).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it.each([false, true])(
    "fences a held image preparation after Stop fully finishes (settlement observed=%s), keeps its original reusable and admits a genuinely new send",
    async (settled) => {
      const f = await queuedImageFixture();
      const preparing = deferredSignal();
      const releaseCopy = deferredSignal();
      const hold = f.store.holdPendingImages.bind(f.store);
      const held = vi
        .spyOn(f.store, "holdPendingImages")
        .mockImplementation(async (...args) => {
          preparing.resolve();
          await releaseCopy.promise;
          return hold(...args);
        });
      try {
        const image = await f.store.add(upload("still-owned.png", "image/png"));
        const before = f.worker.commands.filter(
          ({ type }) => type === "prompt",
        ).length;
        const oldSend = f.runtime.prompt({
          sessionId: "a",
          message: "old preparation",
          behavior: "steer",
          attachmentIds: [image.id],
        });
        void oldSend.catch(() => {});
        await preparing.promise;
        f.worker.responseOverrides.set("abort", () => {
          if (settled) f.worker.emit("event", { type: "agent_settled" });
          return {};
        });
        await expect(f.runtime.abort("a")).resolves.toEqual({
          steering: [],
          followUp: [],
        });
        if (settled) expect((await f.runtime.snapshot()).runState).toBe("idle");
        expect(
          f.worker.commands.filter(({ type }) => type === "abort"),
        ).toHaveLength(1);
        releaseCopy.resolve();
        await expect(oldSend).rejects.toThrow(
          "This input was stopped before delivery",
        );
        expect(
          f.worker.commands.filter(({ type }) => type === "prompt"),
        ).toHaveLength(before);
        expect((await f.store.imagePreview(image.id)).bytes.toString()).toBe(
          "payload",
        );
        held.mockRestore();
        await f.runtime.prompt({
          sessionId: "a",
          message: "genuinely new post-Stop send",
          attachmentIds: [image.id],
        });
        expect(
          f.worker.commands.filter(({ type }) => type === "prompt"),
        ).toHaveLength(before + 1);
        expect(
          f.worker.commands.findLast(({ type }) => type === "prompt")?.message,
        ).toBe("genuinely new post-Stop send");
      } finally {
        releaseCopy.resolve();
        held.mockRestore();
        await f.runtime.close();
      }
    },
  );

  it.each(["steer", "followUp"] as const)(
    "restores known queued %s images, then recovers identical text quietly",
    async (mode) => {
      const f = await queuedImageFixture();
      try {
        const image = await f.store.add(upload("queued.png", "image/png"));
        await f.runtime.prompt({
          sessionId: "a",
          message: "same text",
          behavior: mode,
          attachmentIds: [image.id],
        });
        await f.runtime.prompt({
          sessionId: "a",
          message: "other mode",
          behavior: mode === "steer" ? "followUp" : "steer",
        });
        const expected =
          mode === "steer"
            ? { steering: ["same text"], followUp: ["other mode"] }
            : { steering: ["other mode"], followUp: ["same text"] };
        const recovered =
          mode === "steer"
            ? await f.runtime.recoverPending("a")
            : await f.runtime.abort("a");
        expect(recovered).toEqual({
          ...expected,
          attachments: [image],
        });
        await f.runtime.prompt({
          sessionId: "a",
          message: "same text",
          behavior: mode,
        });
        await expect(f.runtime.recoverPending("a")).resolves.toEqual(
          mode === "steer"
            ? { steering: ["same text"], followUp: [] }
            : { steering: [], followUp: ["same text"] },
        );
      } finally {
        await f.runtime.close();
      }
    },
  );

  it.each(["same text", ""])(
    "does not warn after consuming an image input with text %j",
    async (text) => {
      const f = await queuedImageFixture();
      try {
        const image = await f.store.add(upload("queued.png", "image/png"));
        await f.runtime.prompt({
          sessionId: "a",
          message: text,
          behavior: "steer",
          attachmentIds: [image.id],
        });
        const command = f.worker.commands.findLast(
          ({ type }) => type === "prompt",
        )!;
        // Pi removes nonempty text before message_start; image-only captions
        // can remain in its public queue projection even after settlement.
        if (text) f.queue.steering = [];
        f.worker.emit("event", { type: "queue_update", ...f.queue });
        f.worker.emit("event", {
          type: "message_start",
          message: {
            role: "user",
            content: [{ type: "text", text }, ...(command.images as object[])],
            timestamp: 1,
          },
        });
        await f.runtime.prompt({
          sessionId: "a",
          message: text || "text only",
          behavior: "steer",
        });
        await expect(f.runtime.recoverPending("a")).resolves.toEqual({
          steering: [text || "text only"],
          followUp: [],
        });
      } finally {
        await f.runtime.close();
      }
    },
  );

  it("does not warn when image consumption races recovery of identical text-only input", async () => {
    const f = await queuedImageFixture();
    try {
      const image = await f.store.add(upload("queued.png", "image/png"));
      await f.runtime.prompt({
        sessionId: "a",
        message: "same text",
        behavior: "steer",
        attachmentIds: [image.id],
      });
      const command = f.worker.commands.findLast(
        ({ type }) => type === "prompt",
      )!;
      await f.runtime.prompt({
        sessionId: "a",
        message: "same text",
        behavior: "steer",
      });
      f.worker.responseOverrides.set("clear_queue", () => {
        f.worker.emit("event", {
          type: "queue_update",
          steering: ["same text"],
          followUp: [],
        });
        f.worker.emit("event", {
          type: "message_start",
          message: {
            role: "user",
            content: [
              { type: "text", text: "same text" },
              ...(command.images as object[]),
            ],
            timestamp: 1,
          },
        });
        f.worker.emit("event", {
          type: "queue_update",
          steering: [],
          followUp: [],
        });
        return { steering: ["same text"], followUp: [] };
      });
      await expect(f.runtime.recoverPending("a")).resolves.toEqual({
        steering: ["same text"],
        followUp: [],
      });
    } finally {
      await f.runtime.close();
    }
  });

  it("preserves pending image recovery when settlement arrives before the clear receipt", async () => {
    const f = await queuedImageFixture();
    try {
      const image = await f.store.add(upload("queued.png", "image/png"));
      await f.runtime.prompt({
        sessionId: "a",
        message: "still pending",
        behavior: "followUp",
        attachmentIds: [image.id],
      });
      const pending = (await f.runtime.snapshot()).pendingQueues!;
      expect(pending.followUp[0]).toEqual({
        id: "text-followUp-0",
        textPreview: "still pending",
        textLength: "still pending".length,
        textTruncated: false,
        imageCount: 1,
        imageAttachmentIds: [image.id],
      });
      expect((await f.store.imagePreview(image.id)).bytes.toString()).toBe(
        "payload",
      );
      f.worker.responseOverrides.set("clear_queue", () => {
        const input = structuredClone(f.queue);
        f.queue.steering = [];
        f.queue.followUp = [];
        f.worker.emit("event", { type: "queue_update", ...f.queue });
        f.worker.emit("event", { type: "agent_settled" });
        return input;
      });
      await expect(f.runtime.recoverPending("a")).resolves.toEqual({
        steering: [],
        followUp: ["still pending"],
        attachments: [image],
      });
      expect((await f.store.imagePreview(image.id)).bytes.toString()).toBe(
        "payload",
      );
    } finally {
      await f.runtime.close();
    }
  });

  it.each(["clear", "retire"] as const)(
    "forgets image-risk evidence when input is removed by %s",
    async (boundary) => {
      const f = await queuedImageFixture();
      try {
        const image = await f.store.add(upload("queued.png", "image/png"));
        await f.runtime.prompt({
          sessionId: "a",
          message: "same text",
          behavior: "followUp",
          attachmentIds: [image.id],
        });
        if (boundary === "clear") await f.runtime.clearPending("a");
        else {
          f.worker.emit("exit", new Error("fixture worker retired"));
          await vi.waitFor(() => expect(f.worker.stops).toBe(1));
          await f.runtime.prompt({ sessionId: "a", message: "new run" });
          await waitForReady(f.runtime);
        }
        f.worker.emit("event", { type: "agent_start" });
        await f.runtime.prompt({
          sessionId: "a",
          message: "same text",
          behavior: "followUp",
        });
        await expect(f.runtime.recoverPending("a")).resolves.toEqual({
          steering: [],
          followUp: ["same text"],
        });
      } finally {
        await f.runtime.close();
      }
    },
  );

  it("recovers mixed Host-held input without resuming it when compaction ends", async () => {
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      worker.responseOverrides.set("get_state", {
        sessionId: "a",
        sessionFile: worker.sessionPath,
        isStreaming: false,
        isCompacting: true,
      });
      worker.emit("event", { type: "compaction_start", reason: "manual" });
      const requests = [
        runtime.prompt({
          sessionId: "a",
          message: "queue one",
          behavior: "followUp",
        }),
        runtime.prompt({
          sessionId: "a",
          message: "steer one",
          behavior: "steer",
        }),
        runtime.prompt({
          sessionId: "a",
          message: "steer two",
          behavior: "steer",
        }),
      ].map((promise) => promise.catch((error: unknown) => error));
      await vi.waitFor(async () =>
        expect((await runtime.snapshot()).pendingQueues!.totalCount).toBe(3),
      );
      await expect(runtime.recoverPending("a")).resolves.toEqual({
        steering: ["steer one", "steer two"],
        followUp: ["queue one"],
      });
      expect(await Promise.all(requests)).toEqual(
        Array.from({ length: 3 }, () =>
          expect.objectContaining({ code: "PROMPT_RECOVERED" }),
        ),
      );
      worker.emit("event", {
        type: "compaction_end",
        reason: "manual",
        result: {},
      });
      await new Promise<void>((done) => setImmediate(done));
      expect(
        worker.commands.some(
          ({ type }) => type === "prompt" || type === "abort",
        ),
      ).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("clears Pi input before Stop and refuses delivery while stopping", async () => {
    let worker!: FakeRpc;
    const clearGate = deferredSignal();
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      worker.emit("event", { type: "agent_start" });
      worker.responseOverrides.set("clear_queue", async () => {
        await clearGate.promise;
        worker.emit("event", {
          type: "queue_update",
          steering: [],
          followUp: [],
        });
        return { steering: ["recover steer"], followUp: ["recover follow"] };
      });
      const abort = runtime.abort("a");
      await vi.waitFor(() =>
        expect(worker.commands.some(({ type }) => type === "clear_queue")).toBe(
          true,
        ),
      );
      await expect(
        runtime.prompt({
          sessionId: "a",
          message: "new input",
          behavior: "followUp",
        }),
      ).rejects.toThrow("Stop is in progress");
      clearGate.resolve();
      await expect(abort).resolves.toEqual({
        steering: ["recover steer"],
        followUp: ["recover follow"],
      });
      expect(
        worker.commands
          .filter(({ type }) => type === "clear_queue" || type === "abort")
          .map(({ type }) => type),
      ).toEqual(["clear_queue", "abort"]);
      expect(worker.commands.some(({ type }) => type === "prompt")).toBe(false);
    } finally {
      clearGate.resolve();
      await runtime.close();
    }
  });

  it("reports unavailable recovery and hard-stops instead of aborting with a live queue", async () => {
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      worker.emit("event", { type: "agent_start" });
      worker.responseOverrides.set("clear_queue", () => {
        throw new Error("queue read failed");
      });
      await expect(runtime.abort("a")).resolves.toMatchObject({
        error: "queue read failed",
      });
      expect(worker.stops).toBe(1);
      expect(worker.commands.some(({ type }) => type === "abort")).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("clears the public Pi queue at its current boundary without rewriting newer projections", async () => {
    const store = trackedAttachmentStore();
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );
    await runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    const forwarded: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) =>
      forwarded.push(event as Record<string, unknown>),
    );

    worker.emit("event", {
      type: "queue_update",
      steering: ["first"],
      followUp: ["later"],
    });
    expect(forwarded.at(-1)).toMatchObject({
      type: "queue_update",
      pendingQueues: { totalCount: 2, revision: expect.any(Number) },
    });
    expect(forwarded.at(-1)).not.toHaveProperty("steering");
    expect(forwarded.at(-1)).not.toHaveProperty("followUp");
    worker.responseOverrides.set("clear_queue", () => {
      // Pi consumed 'first' before the operation, cleared 'later', then
      // another producer queued new work before the HTTP receipt arrived.
      worker.emit("event", {
        type: "queue_update",
        steering: [],
        followUp: [],
      });
      worker.emit("event", {
        type: "queue_update",
        steering: ["new"],
        followUp: [],
      });
      return { steering: [], followUp: ["later"] };
    });
    await expect(runtime.clearPending("a")).resolves.toBeUndefined();
    expect(
      worker.commands.filter((command) => command.type === "clear_queue"),
    ).toEqual([{ type: "clear_queue" }]);
    expect((await runtime.snapshot()).pendingQueues).toMatchObject({
      totalCount: 1,
      steering: [{ textPreview: "new" }],
      followUp: [],
    });
    expect(worker.commands.some((command) => command.type === "abort")).toBe(
      false,
    );
    await runtime.close();
  });
});
