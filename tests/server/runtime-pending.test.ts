import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projectPendingQueues } from "../../server/runtime-pending.js";
import { ATTACHMENT_CONTEXT_HEADING } from "../../shared/attachment-context.js";
import {
  MAX_PENDING_MESSAGES,
  MAX_PENDING_PREVIEW_CHARS,
  parsePendingQueues,
  type PendingInput,
} from "../../shared/contracts.js";
import {
  deferredSignal,
  disposeRuntimeFixture,
  fakeRuntime,
  initializeRuntimeFixture,
  persistedRecord,
  startWorker,
  trackedAttachmentStore,
  trackRuntime,
  upload,
} from "./fixtures/runtime.js";

const trailer = `${ATTACHMENT_CONTEXT_HEADING}\n- "/demo/report.csv"`;
const emptyInput = (): PendingInput => ({ steering: [], followUp: [] });

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

async function fixture({ running = true, track = true } = {}) {
  const store = trackedAttachmentStore();
  const f = fakeRuntime({
    attachments: store,
    sessions: [await persistedRecord("a")],
  });
  if (track) trackRuntime(f.runtime);
  await f.runtime.openSession("a");
  await startWorker(f.runtime);
  const worker = f.workers[0]!;
  if (running) worker.emit("event", { type: "agent_start" });
  const publish = (steering: unknown[], followUp: unknown[] = []) =>
    worker.emit("event", { type: "queue_update", steering, followUp });
  const snapshot = () => f.runtime.snapshot("a");
  const read = async () => {
    const { active, pendingQueues } = await snapshot();
    return {
      sessionId: "a",
      viewId: active!.transcriptPage.viewId,
      revision: pendingQueues!.revision,
    };
  };
  const waitForQueue = (count: number) =>
    vi.waitFor(async () => {
      const { pendingQueues } = await snapshot();
      expect(pendingQueues?.totalCount).toBe(count);
      return pendingQueues!;
    });
  return { ...f, store, worker, snapshot, publish, read, waitForQueue };
}

it.each(["Return", "Stop"] as const)(
  "keeps Host-held image bytes when metadata fails during %s",
  async (action) => {
    const f = await fixture({ running: false });
    const { runtime, worker, store } = f;
    const image = await store.add(upload("original.png", "image/png"));
    worker.emit("event", { type: "compaction_start", reason: "auto" });
    worker.responseOverrides.set("get_state", {
      sessionId: "a",
      isCompacting: true,
      isStreaming: false,
    });
    const sending = runtime
      .prompt({
        sessionId: "a",
        message: "",
        behavior: "followUp",
        attachmentIds: [image.id],
      })
      .catch((error: unknown) => error);
    await f.waitForQueue(1);
    const metadata = vi
      .spyOn(store, "pendingImageAttachments")
      .mockImplementation(() => {
        throw new Error("image unavailable");
      });
    if (action === "Return") {
      await expect(runtime.recoverPending("a")).rejects.toThrow(
        "image unavailable",
      );
      expect((await f.snapshot()).pendingQueues?.totalCount).toBe(1);
      metadata.mockRestore();
      await expect(runtime.recoverPending("a")).resolves.toMatchObject({
        followUp: [""],
        attachments: [image],
      });
      expect(await sending).toMatchObject({
        code: "PROMPT_RECOVERED",
        recoveredAttachments: [image],
      });
    } else {
      expect(await runtime.abort("a")).toMatchObject({
        error: "image unavailable",
      });
      expect(worker.stops).toBe(1);
      expect(await sending).toBeInstanceOf(Error);
    }
    expect((await f.snapshot()).pendingQueues?.totalCount).toBe(0);
    expect((await store.imagePreview(image.id)).bytes.toString()).toBe(
      "payload",
    );
  },
);

it("keeps bounded Pending visible but requires a complete current queue for Copy", async () => {
  const f = await fixture();
  const exact = `${"x".repeat(70_000)}END\n\n${trailer}`;
  const steering = [
    exact,
    ...Array.from(
      { length: MAX_PENDING_MESSAGES },
      (_, index) => `steer-${index}`,
    ),
  ];
  f.publish(steering, ["hidden follow"]);
  const { pendingQueues } = await f.snapshot();
  const read = await f.read();
  const item = { ...read, itemId: pendingQueues!.steering[0]!.id };
  expect(pendingQueues).toMatchObject({
    totalCount: steering.length + 1,
    followUp: [],
  });
  expect(pendingQueues!.steering).toHaveLength(MAX_PENDING_MESSAGES);
  expect(pendingQueues!.steering[0]!.textPreview).toContain("report.csv");
  expect(pendingQueues!.steering[0]!.textPreview).not.toContain("/demo/");
  await expect(f.runtime.pendingText(item)).resolves.toEqual({
    text: exact,
    images: [],
  });
  const all = await f.runtime.pendingText(read);
  expect(all.text).toContain(exact.replace(/\n/g, "\n   "));
  expect(all.text).toContain(`${steering.length + 1}. hidden follow`);
  f.publish(["unverified"], [42]);
  expect((await f.snapshot()).pendingQueues).toEqual(pendingQueues);
  await expect(f.runtime.pendingText(read)).rejects.toThrow(
    "Complete pending text is unavailable",
  );
  f.publish(steering.slice(1), ["hidden follow"]);
  f.worker.emit("event", { type: "agent_settled", messages: [] });
  await f.waitForQueue(steering.length);
  await expect(f.runtime.pendingText(item)).rejects.toThrow(
    "Pending input changed",
  );
  const current = await f.read();
  f.worker.emit("exit", new Error("replacement required"));
  await f.waitForQueue(0);
  await expect(f.runtime.pendingText(current)).rejects.toThrow(
    "Pending input changed",
  );
});

it("fences a held image preparation after Stop has already settled", async () => {
  const f = await fixture();
  const { runtime, worker, store } = f;
  const image = await store.add(upload("held.png", "image/png"));
  const waiting = deferredSignal();
  const release = deferredSignal();
  const hold = store.holdPendingImages.bind(store);
  vi.spyOn(store, "holdPendingImages").mockImplementationOnce(
    async (...args) => {
      waiting.resolve();
      await release.promise;
      return hold(...args);
    },
  );
  const sending = expect(
    runtime.prompt({
      sessionId: "a",
      message: "Before Stop",
      behavior: "steer",
      attachmentIds: [image.id],
    }),
  ).rejects.toThrow("This input was stopped before delivery");
  try {
    await waiting.promise;
    worker.responseOverrides.set("abort", () => {
      worker.emit("event", { type: "agent_settled" });
      return {};
    });
    await expect(runtime.abort("a")).resolves.toEqual(emptyInput());
    expect((await f.snapshot()).sessionStatuses.a?.runState).toBe("idle");
    release.resolve();
    await sending;
    const dispatched = () =>
      worker.commands
        .filter(({ type }) => type === "prompt")
        .map(({ message }) => message);
    expect(dispatched()).toEqual([]);
    expect((await store.imagePreview(image.id)).bytes.toString()).toBe(
      "payload",
    );
    await runtime.prompt({
      sessionId: "a",
      message: "After Stop",
      attachmentIds: [image.id],
    });
    expect(dispatched()).toEqual(["After Stop"]);
  } finally {
    release.resolve();
  }
});

it.each(["unconfirmed retirement", "unreadable queue"] as const)(
  "recovers before Stop, while refusing new input during %s",
  async (fault) => {
    const f = await fixture({ track: fault === "unreadable queue" });
    const { runtime, worker } = f;
    const clearing = deferredSignal();
    const release = deferredSignal();
    const input = { steering: ["steering"], followUp: ["follow"] };
    const unreadable = fault === "unreadable queue";
    const stop = vi.spyOn(worker, "stop");
    const failure = new Error(fault);
    if (!unreadable) {
      stop.mockRejectedValueOnce(failure);
      worker.responseOverrides.set("abort", () => {
        throw new Error("Abort transport lost");
      });
    }
    worker.responseOverrides.set("clear_queue", async () => {
      clearing.resolve();
      await release.promise;
      if (unreadable) throw failure;
      f.publish([]);
      return input;
    });
    const stopping = runtime.abort("a");
    try {
      await clearing.promise;
      await expect(
        runtime.prompt({
          sessionId: "a",
          message: "new",
          behavior: "followUp",
        }),
      ).rejects.toThrow("Stop is in progress");
      release.resolve();
      await expect(stopping).resolves.toEqual({
        ...(unreadable ? emptyInput() : input),
        error: fault,
      });
      expect(stop).toHaveBeenCalledOnce();
      expect(
        worker.commands.filter(({ type }) => type === "abort"),
      ).toHaveLength(unreadable ? 0 : 1);
    } finally {
      release.resolve();
      if (!unreadable) {
        await expect(runtime.close()).rejects.toBe(failure);
      }
    }
  },
);

it.each(["Clear", "Return"] as const)(
  "%s leaves later Pi admissions visible",
  async (action) => {
    const f = await fixture();
    const emitted = vi.fn();
    f.runtime.on("event", emitted);
    f.publish(["consumed"], ["still queued"]);
    expect(emitted.mock.lastCall?.[0]).toMatchObject({
      type: "queue_update",
      pendingQueues: { totalCount: 2 },
    });
    expect(emitted.mock.lastCall?.[0]).not.toHaveProperty("followUp");
    const dequeued = { steering: [], followUp: ["still queued"] };
    f.worker.responseOverrides.set("clear_queue", () => {
      f.publish(["new"]);
      return dequeued;
    });
    if (action === "Return")
      await expect(f.runtime.recoverPending("a")).resolves.toEqual(dequeued);
    else await f.runtime.clearPending("a");
    const snapshot = await f.snapshot();
    expect(snapshot.sessionStatuses.a?.runState).toBe("running");
    expect(snapshot.pendingQueues).toMatchObject({
      steering: [{ textPreview: "new" }],
      followUp: [],
    });
  },
);

it("projects both queues with readable bounded previews and exact totals", () => {
  const text = `A${"🧭".repeat(300)}Z`;
  const multiline = "first\nsecond\nthird\nunshown\nlast";
  const rows = [text, multiline, `Use it\n\n${trailer}`, trailer];
  const host = rows.map((message) => ({
    message,
    behavior: "followUp" as const,
    imageCount: 0,
  }));
  const queue = projectPendingQueues(
    { steering: rows.map((text) => ({ text })), followUp: [] },
    host,
    3,
  );
  expect(parsePendingQueues(queue)).toEqual(queue);
  expect(queue.steering.map(({ textPreview }) => textPreview).slice(1)).toEqual(
    ["first\nsecond\nthird\n…\nlast", "Use it\n\nreport.csv", "report.csv"],
  );
  for (const field of ["textPreview", "textLength", "textTruncated"] as const)
    expect(queue.steering.map((row) => row[field])).toEqual(
      queue.followUp.map((row) => row[field]),
    );
  const first = queue.steering[0]!;
  expect(first).toMatchObject({ textLength: text.length, textTruncated: true });
  expect(first.textPreview).not.toMatch(/\p{Surrogate}/u);
  expect(first.textPreview.length).toBeLessThanOrEqual(
    MAX_PENDING_PREVIEW_CHARS,
  );
  expect(first.textPreview).toMatch(/^A.*\n…\n.*Z$/u);
  const pi = {
    steering: Array.from({ length: MAX_PENDING_MESSAGES + 1 }, (_, index) => ({
      text: "",
      imageCount: index === MAX_PENDING_MESSAGES ? 2 : undefined,
    })),
    followUp: [],
  };
  const held = { message: "", behavior: "followUp" as const };
  const full = projectPendingQueues(pi, [{ ...held, imageCount: 3 }], 3);
  expect(full).toMatchObject({
    revision: 4,
    totalCount: MAX_PENDING_MESSAGES + 2,
    totalImageCount: 5,
    followUp: [],
  });
  expect(full.steering).toHaveLength(MAX_PENDING_MESSAGES);
  expect(
    projectPendingQueues(pi, [{ ...held, imageCount: null }], 3),
  ).not.toHaveProperty("totalImageCount");
});

it("validates coordinates, preview lengths and image handles together", () => {
  const known = {
    text: "",
    imageCount: 1,
    imageAttachmentIds: ["12345678-1234-1234-1234-123456789012"],
  };
  const queue = projectPendingQueues(
    {
      steering: [known, { text: "" }],
      followUp: [{ text: "caption", imageCount: 2 }],
    },
    [],
    0,
  );
  expect(parsePendingQueues(queue)).toEqual(queue);
  expect(queue.steering[0]).toMatchObject({
    imageCount: 1,
    imageAttachmentIds: known.imageAttachmentIds,
  });
  expect(queue.steering[1]).not.toHaveProperty("imageCount");
  expect(queue.followUp[0]).toMatchObject({
    textPreview: "caption",
    imageCount: 2,
  });
  const row = queue.followUp[0]!;
  for (const change of [
    { id: "x".repeat(129) },
    { id: queue.steering[0]!.id },
    { textTruncated: true },
    { textLength: 8.5 },
    { imageCount: 0 },
    { imageCount: 1.5 },
    { imageCount: "2" },
    { imageAttachmentIds: ["data:image/png;base64,AAAA"] },
    { imageAttachmentIds: known.imageAttachmentIds },
  ])
    expect(
      parsePendingQueues({ ...queue, followUp: [{ ...row, ...change }] }),
    ).toBeNull();
  for (const patch of [
    { totalCount: 0 },
    { totalCount: 0.5 },
    { totalImageCount: 2 },
    { totalImageCount: 1.5 },
    { totalImageCount: "3" },
  ])
    expect(parsePendingQueues({ ...queue, ...patch })).toBeNull();
  const { totalImageCount, ...unknownTotal } = queue;
  expect(totalImageCount).toBe(3);
  expect(parsePendingQueues(unknownTotal)).toEqual(unknownTotal);
});
