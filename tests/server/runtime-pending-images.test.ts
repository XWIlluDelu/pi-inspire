import { stageUpload } from "./fixtures/runtime.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { userMessageEvidence } from "../../server/pending-image-evidence.js";
import { PendingImageRecovery } from "../../server/runtime-pending-images.js";
import type { PendingInput } from "../../shared/contracts.js";

let root: string;
let store: AttachmentStore;
let owner: PendingImageRecovery;
let queue: PendingInput;
let messages: unknown[];
const report = vi.fn();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inspire-pending-image-owner-"));
  store = new AttachmentStore(root, null, {
    sweepIntervalMs: 0,
  });
  queue = { steering: [], followUp: [] };
  messages = [];
  owner = new PendingImageRecovery(store, queue, report, async () => ({
    cursor: null,
    messages: messages.flatMap((message) => userMessageEvidence(message) ?? []),
  }));
  await owner.prepare();
});
afterEach(async () => {
  await owner.dispose();
  await store.close();
  await rm(root, { recursive: true, force: true });
});
async function enqueue(
  mode: "steer" | "followUp",
  text: string,
  bytes: string,
  history = false,
) {
  const buffer = Buffer.from(bytes);
  const image = {
    type: "image" as const,
    data: buffer.toString("base64"),
    mimeType: "image/png",
  };
  const upload = history
    ? null
    : await stageUpload(store, {
        originalname: "queued.png",
        mimetype: image.mimeType,
        size: buffer.length,
        buffer,
      } as Express.Multer.File);
  if (upload) await store.resolveForPrompt([upload.id]);
  const delivery = await owner.begin(
    mode,
    text,
    [image],
    upload ? [upload.id] : [],
    history ? [image] : [],
  );
  owner.dispatched(delivery);
  queue[mode === "steer" ? "steering" : "followUp"].push(text);
  owner.observeQueue(queue);
  owner.accepted(delivery, "queued");
  if (upload) await store.releaseConsumed([upload.id]);
  return {
    delivery,
    image,
    attachment: store.pendingImageAttachments(delivery.imageIds)[0]!,
    message: {
      role: "user",
      content: [{ type: "text", text }, image],
      timestamp: Date.now(),
    },
  };
}
function boundary() {
  const fence = { received: false };
  const clear = owner.beginClear(fence);
  const input = structuredClone(queue);
  queue = { steering: [], followUp: [] };
  owner.observeQueue(queue);
  fence.received = true;
  return { clear, input };
}

describe("worker-bound pending image ownership", () => {
  it("returns unwritten preparations to their existing owner and never deletes a restaged original on retirement", async () => {
    const buffer = Buffer.from("original bytes");
    const image = await stageUpload(store, {
      originalname: "queued.png",
      mimetype: "image/png",
      size: buffer.length,
      buffer,
    } as Express.Multer.File);
    const resolved = await store.resolveForPrompt([image.id]);
    await owner.begin(
      "steer",
      "prepared only",
      resolved.images,
      [image.id],
      [],
    );
    const clear = owner.beginClear({ received: false });
    owner.observeQueue(queue);
    expect(await owner.finishClear(clear, queue, true)).toEqual({});
    expect((await store.imagePreview(image.id)).bytes).toEqual(buffer);
    await owner.dispose();
    expect((await store.imagePreview(image.id)).bytes).toEqual(buffer);
  });
  it.each(["persisted append", "missing"] as const)(
    "fences same-caption images across modes using $0 evidence",
    async (evidence) => {
      const follow = await enqueue("followUp", "same", "follow image");
      const steer = await enqueue("steer", "same", "steer image");
      queue.steering = [];
      owner.observeQueue(queue); // Pi reports the Steer caption even though Queue started.

      const { clear, input } = boundary();
      if (evidence === "persisted append") messages = [follow.message];
      await owner.corroborate(clear);
      expect(await owner.finishClear(clear, input, true)).toEqual(
        evidence === "missing"
          ? {
              warning: expect.stringContaining(
                "could not be correlated safely",
              ),
            }
          : { attachments: [steer.attachment] },
      );
      if (evidence === "persisted append") owner.observeMessage(follow.message);
      await expect(
        store.imagePreview(follow.attachment.id),
      ).rejects.toMatchObject({ status: 404 });
      const remaining = expect(store.imagePreview(steer.attachment.id));
      if (evidence === "missing")
        await remaining.rejects.toMatchObject({ status: 404 });
      else await remaining.resolves.toBeDefined();
    },
  );

  it("does not correlate a late admission across clear fences or retire transferred handles", async () => {
    const first = await enqueue("followUp", "first", "first image");
    const firstClear = boundary();
    const late = await enqueue("followUp", "late", "late image", true);
    for (const [entry, clear] of [
      [first, firstClear],
      [late, boundary()],
    ] as const) {
      expect(await owner.finishClear(clear.clear, clear.input, true)).toEqual({
        attachments: [entry.attachment],
      });
      expect(
        (await store.imagePreview(entry.attachment.id)).bytes.toString(
          "base64",
        ),
      ).toBe(entry.image.data);
      owner.accepted(entry.delivery, "queued");
    }
    await owner.dispose();
    for (const { attachment } of [first, late]) {
      await store.remove(attachment.id);
      await expect(store.imagePreview(attachment.id)).rejects.toMatchObject({
        status: 404,
      });
    }
  });

  it("keeps copies through a failed clear, but explicit discard releases both uploads and history copies", async () => {
    const upload = await enqueue("steer", "upload", "upload image");
    const recalled = await enqueue(
      "followUp",
      "history",
      "history image",
      true,
    );
    const failed = owner.beginClear({ received: false });
    owner.cancelClear(failed);
    await expect(
      store.imagePreview(upload.attachment.id),
    ).resolves.toBeDefined();
    await expect(
      store.imagePreview(recalled.attachment.id),
    ).resolves.toBeDefined();
    const { clear, input } = boundary();
    expect(await owner.finishClear(clear, input, false)).toEqual({});
    for (const item of [upload, recalled])
      await expect(
        store.resolveForPrompt([item.attachment.id]),
      ).rejects.toMatchObject({ code: "ATTACHMENTS_EXPIRED" });
  });
});
