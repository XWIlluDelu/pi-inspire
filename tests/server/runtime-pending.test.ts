import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiRpcProcess } from "../../server/pi-rpc.js";
import { projectPendingQueues } from "../../server/runtime-pending.js";
import { RuntimeController } from "../../server/runtime.js";
import { ATTACHMENT_CONTEXT_HEADING } from "../../shared/attachment-context.js";
import {
  MAX_PENDING_MESSAGES,
  MAX_PENDING_PREVIEW_CHARS,
  parsePendingMessageSummary,
  parsePendingQueues,
} from "../../shared/contracts.js";
import {
  catalog,
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  initializeRuntimeFixture,
  preview,
  record,
  schedulingRuntime,
  trackedAttachmentStore,
  trackRuntime,
  upload,
  waitForReady,
} from "./fixtures/runtime.js";

async function queuedImageFixture() {
  const store = trackedAttachmentStore();
  const queue = { steering: [] as string[], followUp: [] as string[] };
  const { runtime, workers } = schedulingRuntime({
    attachments: store,
    configure(worker) {
      queue.steering = [];
      queue.followUp = [];
      const publishQueue = () =>
        worker.emit("event", {
          type: "queue_update",
          ...structuredClone(queue),
        });
      worker.responseOverrides.set(
        "prompt",
        (command: Record<string, unknown>) => {
          if (command.streamingBehavior) {
            const texts =
              command.streamingBehavior === "steer"
                ? queue.steering
                : queue.followUp;
            texts.push(String(command.message));
            publishQueue();
          }
          return {};
        },
      );
      worker.responseOverrides.set("clear_queue", () => {
        const result = structuredClone(queue);
        queue.steering = [];
        queue.followUp = [];
        publishQueue();
        return result;
      });
    },
  });
  await runtime.openSession("a");
  await waitForReady(runtime);
  workers[0]!.emit("event", { type: "agent_start" });
  return {
    runtime,
    store,
    queue,
    get worker() {
      return workers.at(-1)!;
    },
  };
}

const savedImage = {
  data: Buffer.from("saved pixels").toString("base64"),
  mimeType: "image/png",
};

function recalledImageFixture() {
  const store = trackedAttachmentStore();
  let worker!: FakeRpc;
  const runtime = new RuntimeController(catalog([record("a", "/tmp")]), store, {
    createProcess(options) {
      worker = new FakeRpc(options);
      return worker as unknown as PiRpcProcess;
    },
    openSessionProjection: (session) =>
      preview(session, [
        messageEntry("original", null, {
          role: "user",
          timestamp: 1,
          content: [{ type: "image", ...savedImage }],
        }),
      ]),
  });
  return {
    runtime,
    store,
    get worker() {
      return worker;
    },
  };
}

import { messageEntry } from "./fixtures/session-jsonl.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("RuntimeController Pending input and recovery", () => {
  it.each([
    { action: "return", unavailable: true, caption: "caption" },
    { action: "stop", unavailable: true, caption: "caption" },
    { action: "stop", unavailable: false, caption: "" },
  ] as const)(
    "handles Host-held images on $action (metadata unavailable=$unavailable)",
    async ({ action, unavailable, caption }) => {
      const attachments = trackedAttachmentStore();
      const f = schedulingRuntime({ attachments });
      trackRuntime(f.runtime);
      await f.runtime.openSession("a");
      await waitForReady(f.runtime);
      const image = await attachments.add(upload("original.png", "image/png"));
      f.worker.emit("event", { type: "compaction_start", reason: "auto" });
      f.worker.responseOverrides.set("get_state", () => ({
        sessionId: "a",
        isCompacting: true,
        isStreaming: false,
      }));
      const delivery = f.runtime
        .prompt({
          sessionId: "a",
          message: caption,
          behavior: "followUp",
          attachmentIds: [image.id],
        })
        .catch((error) => error);
      await vi.waitFor(async () =>
        expect((await f.runtime.snapshot()).pendingQueues?.totalCount).toBe(1),
      );
      const metadata = vi.spyOn(attachments, "pendingImageAttachments");
      if (unavailable)
        metadata.mockImplementation(() => {
          throw new Error("image unavailable");
        });
      if (action === "return") {
        await expect(f.runtime.recoverPending("a")).rejects.toThrow(
          "image unavailable",
        );
        expect((await f.runtime.snapshot()).pendingQueues?.totalCount).toBe(1);
        metadata.mockRestore();
      }
      const receipt =
        action === "return"
          ? await f.runtime.recoverPending("a")
          : await f.runtime.abort("a");
      if (unavailable && action === "stop") {
        expect(receipt).toMatchObject({ error: "image unavailable" });
        expect(f.worker.stops).toBe(1);
        expect(await delivery).toBeInstanceOf(Error);
      } else {
        expect(receipt).toMatchObject({
          followUp: [caption],
          attachments: [image],
        });
        expect(await delivery).toMatchObject({
          code: "PROMPT_RECOVERED",
          recoveredAttachments: [image],
        });
      }
      expect((await f.runtime.snapshot()).pendingQueues?.totalCount).toBe(0);
      expect((await attachments.imagePreview(image.id)).bytes.toString()).toBe(
        "payload",
      );
    },
  );

  it("returns, copies and clears Host-held compaction input, then delivers only new input", async () => {
    const gate = deferredSignal();
    const f = recalledImageFixture();
    const { runtime, store } = f;
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      const { worker } = f;
      worker.responseOverrides.set("compact", () => gate.promise);
      const compacting = runtime.nativeCommand({
        sessionId: "a",
        command: "compact",
      });
      await vi.waitFor(() =>
        expect(worker.commands).toContainEqual(
          expect.objectContaining({ type: "compact" }),
        ),
      );

      const page = (await runtime.snapshot()).active!.transcriptPage;
      const queueSavedImage = () =>
        runtime
          .prompt({
            sessionId: "a",
            message: "",
            behavior: "followUp",
            historyArtifacts: {
              viewId: page.viewId,
              incarnation: page.incarnation ?? null,
              effectiveLeafId: page.effectiveLeafId ?? null,
              imageReferences: ["pi-history-image://original/0"],
              fileReferences: [],
            },
          })
          .catch((error: unknown) => error);
      const waitForQueue = (count: number) =>
        vi.waitFor(async () => {
          const { pendingQueues } = await runtime.snapshot();
          expect(pendingQueues?.totalCount).toBe(count);
          return pendingQueues!;
        });
      const recalledDelivery = queueSavedImage();
      const steering = ["first steer", "second steer"];
      const textDeliveries = steering.map((message) =>
        runtime
          .prompt({ sessionId: "a", message, behavior: "steer" })
          .catch((error: unknown) => error),
      );
      await waitForQueue(3);
      const returned = await runtime.recoverPending("a");
      expect(returned).toMatchObject({ steering, followUp: [""] });
      expect(returned.attachments).toHaveLength(1);
      expect(await recalledDelivery).toMatchObject({
        code: "PROMPT_RECOVERED",
        recoveredAttachments: returned.attachments,
      });
      for (const receipt of await Promise.all(textDeliveries))
        expect(receipt).toMatchObject({ code: "PROMPT_RECOVERED" });
      expect(
        (
          await store.imagePreview(returned.attachments![0]!.id)
        ).bytes.toString(),
      ).toBe("saved pixels");

      const [first, second, file] = await store.addMany([
        upload("first.png", "image/png"),
        upload("second.png", "image/png"),
        upload("notes.txt", "text/plain"),
      ]);
      const removed = [
        runtime
          .prompt({
            sessionId: "a",
            message: "Remove me",
            behavior: "steer",
            attachmentIds: [second!.id, file!.id, first!.id, second!.id],
          })
          .catch((error: unknown) => error),
        queueSavedImage(),
      ];
      const queue = await waitForQueue(2);
      const copy = {
        sessionId: "a",
        viewId: page.viewId,
        revision: queue.revision,
      };
      const recalled = { ...copy, itemId: queue.followUp[0]!.id };
      await expect(runtime.pendingText(copy)).resolves.toEqual({
        text: "1. Remove me\n2. ",
        images: [
          { attachmentId: second!.id },
          { attachmentId: first!.id },
          savedImage,
        ],
      });
      await store.remove(second!.id);
      await expect(runtime.pendingText(copy)).rejects.toThrow(
        "Original pending images are unavailable",
      );
      await expect(runtime.pendingText(recalled)).resolves.toEqual({
        text: "",
        images: [savedImage],
      });

      await runtime.clearPending("a");
      for (const result of await Promise.all(removed))
        expect(result).toMatchObject({ code: "PROMPT_CLEARED" });
      await expect(runtime.pendingText(copy)).rejects.toThrow(
        "Pending input changed",
      );

      const fresh = runtime.prompt({
        sessionId: "a",
        message: "Fresh input",
        behavior: "steer",
      });
      await waitForQueue(1);
      const delivered = () =>
        worker.commands.filter(({ type }) => type === "prompt");
      expect(delivered()).toEqual([]);
      worker.emit("event", {
        type: "compaction_end",
        reason: "manual",
        result: {},
      });
      gate.resolve();
      await Promise.all([compacting, fresh]);
      expect(delivered()).toMatchObject([{ message: "Fresh input" }]);
    } finally {
      gate.resolve();
      await runtime.close();
    }
  });

  it("keeps Clear and later input independent of blocked extension and Steer receipts", async () => {
    const extensionGate = deferredSignal();
    const steeringGate = deferredSignal();
    let streaming = false;
    const f = schedulingRuntime({
      configure(worker) {
        worker.responseOverrides.set("get_commands", {
          commands: [{ name: "slow", source: "extension" }],
        });
      },
    });
    const { runtime } = f;
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      const { worker } = f;
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
      await runtime.clearPending("a");
      expect((await runtime.snapshot()).runState).toBe("running");
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

  it("keeps bounded Pending visible while Copy requires the full queue at its current revision", async () => {
    const f = schedulingRuntime();
    const { runtime } = f;
    trackRuntime(runtime);
    await runtime.openSession("a");
    await waitForReady(runtime);
    const longText = `${"x".repeat(70_000)}END\n\n${ATTACHMENT_CONTEXT_HEADING}\n- "/demo/report.csv"`;
    const steering = [
      longText,
      ...Array.from({ length: 1001 }, (_, index) => `steer-${index}`),
    ];
    f.worker.emit("event", {
      type: "queue_update",
      steering,
      followUp: ["hidden follow"],
    });
    const snapshot = await runtime.snapshot();
    const firstRow = snapshot.pendingQueues!.steering[0]!;
    const request = {
      sessionId: "a",
      viewId: snapshot.active!.transcriptPage.viewId,
      revision: snapshot.pendingQueues!.revision,
    };
    expect(snapshot.pendingQueues).toMatchObject({
      totalCount: 1003,
    });
    expect(snapshot.pendingQueues!.steering.length).toBeLessThan(
      steering.length,
    );
    expect(firstRow.textPreview).toContain("report.csv");
    expect(firstRow.textPreview).not.toContain("/demo/");
    const readFirst = () =>
      runtime.pendingText({ ...request, itemId: firstRow.id });
    await expect(readFirst()).resolves.toEqual({ text: longText });
    const { text: all } = await runtime.pendingText(request);
    expect(all).toContain(longText.replace(/\n/g, "\n   "));
    expect(all).toContain("1003. hidden follow");
    expect((await runtime.snapshot()).pendingQueues).toEqual(
      snapshot.pendingQueues,
    );
    f.worker.emit("event", {
      type: "queue_update",
      steering: ["unverified"],
      followUp: [42],
    });
    expect((await runtime.snapshot()).pendingQueues).toEqual(
      snapshot.pendingQueues,
    );
    await expect(runtime.pendingText(request)).rejects.toThrow(
      "Complete pending text is unavailable",
    );
    f.worker.emit("event", {
      type: "queue_update",
      steering: steering.slice(1),
      followUp: ["hidden follow"],
    });
    await expect(readFirst()).rejects.toThrow("Pending input changed");
    const settled = new Promise<void>((resolveSettled) =>
      runtime.on("event", (event) => {
        if (event.type === "agent_settled") resolveSettled();
      }),
    );
    f.worker.emit("event", { type: "agent_settled", messages: [] });
    await settled;
    expect((await runtime.snapshot()).pendingQueues).toMatchObject({
      totalCount: 1002,
    });
    f.worker.emit("event", {
      type: "queue_update",
      steering: ["different run, same coordinate"],
      followUp: [],
    });
    await expect(readFirst()).rejects.toThrow("Pending input changed");
    const current = await runtime.snapshot();
    f.worker.emit("exit", new Error("replacement required"));
    expect((await runtime.snapshot()).pendingQueues!.totalCount).toBe(0);
    await expect(
      runtime.pendingText({
        ...request,
        viewId: current.active!.transcriptPage.viewId,
        revision: current.pendingQueues!.revision,
      }),
    ).rejects.toThrow("Pending input changed");
  });

  it("does not make dequeue wait behind a suspended pre-prompt hook", async () => {
    const f = schedulingRuntime();
    const { runtime } = f;
    const hook = deferredSignal();
    let sending: Promise<unknown> | undefined;
    try {
      await runtime.openSession("a");
      await waitForReady(runtime);
      const { worker } = f;
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

  it("does not warn when image consumption races recovery of identical text-only input", async () => {
    const f = await queuedImageFixture();
    trackRuntime(f.runtime);
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
  });

  it("preserves pending image recovery when settlement arrives before the clear receipt", async () => {
    const f = await queuedImageFixture();
    trackRuntime(f.runtime);
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
    const snapshot = await f.runtime.snapshot();
    expect(
      await f.runtime.pendingText({
        sessionId: "a",
        viewId: snapshot.active!.transcriptPage.viewId,
        revision: pending.revision,
      }),
    ).toEqual({
      text: "1. still pending",
      imageAttachmentIds: [image.id],
    });
    expect((await f.runtime.snapshot()).pendingQueues).toEqual(pending);
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
  });

  it.each(["clear", "retire"] as const)(
    "forgets image-risk evidence when input is removed by %s",
    async (boundary) => {
      const f = await queuedImageFixture();
      trackRuntime(f.runtime);
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
    },
  );

  it.each(["stopped", "unconfirmed retirement", "unreadable queue"] as const)(
    "recovers Pi input before Stop and refuses concurrent delivery (%s)",
    async (outcome) => {
      const { runtime, workers } = schedulingRuntime();
      const clearGate = deferredSignal();
      await runtime.openSession("a");
      await waitForReady(runtime);
      const worker = workers[0]!;
      const recovery = {
        steering: ["recover steer"],
        followUp: ["recover follow"],
      };
      const unreadable = outcome === "unreadable queue";
      const unconfirmed = outcome === "unconfirmed retirement";
      const retirementError = new Error("retirement unconfirmed");
      const stop = vi.spyOn(worker, "stop");
      try {
        worker.emit("event", { type: "agent_start" });
        worker.responseOverrides.set("clear_queue", async () => {
          await clearGate.promise;
          if (unreadable) throw new Error("queue read failed");
          worker.emit("event", {
            type: "queue_update",
            steering: [],
            followUp: [],
          });
          return recovery;
        });
        if (unconfirmed) {
          worker.responseOverrides.set("abort", () => {
            throw new Error("abort transport lost");
          });
          stop.mockRejectedValueOnce(retirementError);
        }

        const stopping = runtime.abort("a");
        await vi.waitFor(() =>
          expect(worker.commands).toContainEqual(
            expect.objectContaining({ type: "clear_queue" }),
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
        const receipt = await stopping;
        if (unreadable) {
          expect(receipt.error).toBe("queue read failed");
          expect(worker.stops).toBe(1);
        } else {
          expect(receipt).toMatchObject(recovery);
          expect(receipt.error).toBe(
            unconfirmed ? retirementError.message : undefined,
          );
        }
        expect(
          worker.commands
            .map(({ type }) => type)
            .filter(
              (type) =>
                type === "clear_queue" || type === "abort" || type === "prompt",
            ),
        ).toEqual(unreadable ? ["clear_queue"] : ["clear_queue", "abort"]);
      } finally {
        clearGate.resolve();
        stop.mockRestore();
        if (unconfirmed) await worker.stop();
        await runtime.close().catch((error: unknown) => {
          if (error !== retirementError) throw error;
        });
      }
    },
  );

  it.each(["Clear", "Return"] as const)(
    "%s uses the current Pi queue boundary and preserves later admissions",
    async (action) => {
      const f = schedulingRuntime();
      const { runtime } = f;
      trackRuntime(runtime);
      await runtime.openSession("a");
      await waitForReady(runtime);
      f.worker.emit("event", { type: "agent_start" });
      const observed: Array<Record<string, unknown>> = [];
      runtime.on("event", (event) => observed.push(event));
      f.worker.emit("event", {
        type: "queue_update",
        steering: ["consumed"],
        followUp: ["still queued"],
      });
      expect(observed.at(-1)).toMatchObject({
        type: "queue_update",
        pendingQueues: { totalCount: 2 },
      });
      expect(observed.at(-1)).not.toHaveProperty("steering");
      expect(observed.at(-1)).not.toHaveProperty("followUp");
      f.worker.responseOverrides.set("clear_queue", () => {
        // Pi consumed the steer, dequeued the follow-up, then admitted a new item.
        f.worker.emit("event", {
          type: "queue_update",
          steering: ["new"],
          followUp: [],
        });
        return { steering: [], followUp: ["still queued"] };
      });
      if (action === "Return") {
        await expect(runtime.recoverPending("a")).resolves.toEqual({
          steering: [],
          followUp: ["still queued"],
        });
      } else {
        await runtime.clearPending("a");
      }
      expect(await runtime.snapshot()).toMatchObject({
        runState: "running",
        pendingQueues: {
          totalCount: 1,
          steering: [{ textPreview: "new" }],
          followUp: [],
        },
      });
    },
  );
});

describe("Pending wire contracts", () => {
  const summary = {
    id: "text-steer-0",
    textPreview: "continue",
    textLength: 8,
    textTruncated: false,
  };

  it("bounds visible rows and counts omitted images across both owners when known", () => {
    const pi = {
      steering: Array.from(
        { length: MAX_PENDING_MESSAGES + 1 },
        (_, index) => ({
          text: index ? "" : "first",
          ...(index === MAX_PENDING_MESSAGES ? { imageCount: 2 } : {}),
        }),
      ),
      followUp: [],
    };
    const host = { message: "", behavior: "followUp" as const };
    const merged = projectPendingQueues(pi, [{ ...host, imageCount: 3 }], 3);
    expect(merged).toMatchObject({
      revision: 4,
      totalCount: MAX_PENDING_MESSAGES + 2,
      totalImageCount: 5,
    });
    expect(merged.steering).toHaveLength(MAX_PENDING_MESSAGES);
    expect(merged.followUp).toEqual([]);
    expect(merged.steering[0]).toMatchObject({
      textPreview: "first",
      textLength: 5,
      textTruncated: false,
    });
    expect(parsePendingQueues(merged)).toEqual(merged);
    expect(
      projectPendingQueues(pi, [{ ...host, imageCount: null }], 0)
        .totalImageCount,
    ).toBeUndefined();
  });

  it.each(["Review this report", ""])(
    "projects file references consistently in Pi and Host queues for %j",
    (text) => {
      const trailer = `${ATTACHMENT_CONTEXT_HEADING}\n- "/demo/report.csv"`;
      const message = text ? `${text}\n\n${trailer}` : trailer;
      const preview = text ? `${text}\n\nreport.csv` : "report.csv";
      const queue = projectPendingQueues(
        { steering: [{ text: message }], followUp: [] },
        [{ message, behavior: "followUp", imageCount: 0 }],
        0,
      );
      const expected = {
        textPreview: preview,
        textLength: preview.length,
        textTruncated: false,
      };
      expect(queue.steering[0]).toMatchObject(expected);
      expect(queue.followUp[0]).toMatchObject(expected);
      expect(parsePendingQueues(queue)).toEqual(queue);
    },
  );

  it("rejects invalid image counts and accepts unknown totals", () => {
    const base = {
      revision: 1,
      totalCount: 1,
      steering: [{ ...summary, imageCount: 2 }],
      followUp: [],
    };
    for (const totalImageCount of [-1, 1.5, "2", 1])
      expect(parsePendingQueues({ ...base, totalImageCount })).toBeNull();
    expect(parsePendingQueues({ ...base, totalImageCount: 2 })).not.toBeNull();
    expect(parsePendingQueues(base)).not.toBeNull();
  });

  it.each([
    {
      label: "multiline input",
      text: "first line\nsecond line\nthird line\nhidden middle\nfinal line\n",
      preview: "first line\nsecond line\nthird line\n…\nfinal line",
    },
    {
      label: "Unicode at the cut boundaries",
      text: `A${"🧭".repeat(300)}Z`,
      ends: ["A", "Z"],
    },
    {
      label: "short text",
      text: "短い🧭\nfull text",
      preview: "短い🧭\nfull text",
    },
  ])(
    "keeps both ends or the whole $label in Pi and Host previews",
    ({ text, preview, ends }) => {
      const merged = projectPendingQueues(
        { steering: [{ text }], followUp: [] },
        [{ message: text, behavior: "followUp", imageCount: 0 }],
        0,
      );
      const summary = merged.steering[0]!;
      expect(summary).toMatchObject({
        textLength: text.length,
        textTruncated: preview !== text,
      });
      if (preview !== undefined) expect(summary.textPreview).toBe(preview);
      else {
        const parts = summary.textPreview.split("\n…\n");
        expect(parts).toHaveLength(2);
        const [head, tail] = parts as [string, string];
        expect(head.startsWith(ends![0]!)).toBe(true);
        expect(tail.endsWith(ends![1]!)).toBe(true);
        expect(text.startsWith(head)).toBe(true);
        expect(text.endsWith(tail)).toBe(true);
        expect(summary.textPreview.length).toBeLessThanOrEqual(
          MAX_PENDING_PREVIEW_CHARS,
        );
        expect(summary.textPreview).not.toMatch(/\p{Surrogate}/u);
      }
      expect(merged.followUp[0]).toMatchObject({
        textPreview: summary.textPreview,
        textLength: summary.textLength,
        textTruncated: summary.textTruncated,
      });
      expect(parsePendingQueues(merged)).toEqual(merged);
    },
  );

  it.each([
    ["an invalid identifier", { ...summary, id: "x".repeat(129) }],
    ["a mismatched truncation marker", { ...summary, textTruncated: true }],
    ["a fractional length", { ...summary, textLength: 8.5 }],
    ["a zero image count", { ...summary, imageCount: 0 }],
    ["a fractional image count", { ...summary, imageCount: 1.5 }],
    ["a nonnumeric image count", { ...summary, imageCount: "2" }],
    [
      "image bodies in place of handles",
      {
        ...summary,
        imageCount: 1,
        imageAttachmentIds: ["data:image/png;base64,AAAA"],
      },
    ],
    [
      "image handles without a matching count",
      {
        ...summary,
        imageCount: 2,
        imageAttachmentIds: ["12345678-1234-1234-1234-123456789012"],
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(parsePendingMessageSummary(value)).toBeNull();
  });

  it("preserves known image handles without labeling unknown empty rows or embedding bytes", () => {
    const ids = [
      "12345678-1234-1234-1234-123456789012",
      "12345678-1234-1234-1234-123456789013",
    ];
    const queue = projectPendingQueues(
      {
        steering: [
          { text: "", imageCount: 2, imageAttachmentIds: ids },
          { text: "" },
        ],
        followUp: [{ text: "caption", imageCount: 1 }],
      },
      [],
      0,
    );
    expect(parsePendingQueues(queue)).toEqual(queue);
    expect(queue.steering[0]).toMatchObject({
      textPreview: "",
      textLength: 0,
      imageCount: 2,
      imageAttachmentIds: ids,
    });
    expect(queue.steering[1]).not.toHaveProperty("imageCount");
    expect(queue.steering[1]).not.toHaveProperty("imageAttachmentIds");
    expect(queue.followUp[0]).toMatchObject({
      textPreview: "caption",
      imageCount: 1,
    });
  });

  it("rejects duplicate coordinates and invalid totals", () => {
    const queue = {
      revision: 1,
      totalCount: 2,
      steering: [summary],
      followUp: [summary],
    };
    expect(parsePendingQueues(queue)).toBeNull();
    for (const totalCount of [-1, 0, 0.5, undefined]) {
      expect(
        parsePendingQueues({ ...queue, followUp: [], totalCount }),
      ).toBeNull();
    }
  });
});
