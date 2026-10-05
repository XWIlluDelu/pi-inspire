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
    sessionDirectories: [],
    trashDirectories: [],
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
    : await store.add({
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
    attachment: delivery.attachments[0]!,
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
    const image = await store.add({
      originalname: "queued.png",
      mimetype: "image/png",
      size: buffer.length,
      buffer,
    } as Express.Multer.File);
    const resolved = await store.resolveForPrompt([image.id]);
    const delivery = await owner.begin(
      "steer",
      "prepared only",
      resolved.images,
      [image.id],
      [],
    );
    expect(owner.isPrepared(delivery)).toBe(true);
    const clear = owner.beginClear({ received: false });
    owner.observeQueue(queue);
    expect(await owner.finishClear(clear, queue, true)).toEqual({});
    expect(owner.isPrepared(delivery)).toBe(false);
    expect((await store.imagePreview(image.id)).bytes).toEqual(buffer);
    await owner.dispose();
    expect((await store.imagePreview(image.id)).bytes).toEqual(buffer);
  });
  it("recovers all images in mode/order/multiplicity, including history and more than one send limit", async () => {
    const follows: Array<Awaited<ReturnType<typeof enqueue>>> = [];
    const steers: Array<Awaited<ReturnType<typeof enqueue>>> = [];
    for (let index = 0; index < 10; index++) {
      const mode = index % 2 ? "steer" : "followUp";
      const item = await enqueue(
        mode,
        index === 9 ? "" : "same caption",
        index < 2 ? "identical bytes" : `image ${index}`,
        index === 8,
      );
      (mode === "steer" ? steers : follows).push(item);
      expect(
        (await store.imagePreview(item.attachment.id)).bytes.toString("base64"),
      ).toBe(item.image.data);
      // Inspecting a retained image does not make it available for another send.
      await expect(
        store.resolveForPrompt([item.attachment.id]),
      ).rejects.toMatchObject({
        status: 409,
      });
    }
    const { clear, input } = boundary();
    const recovered = await owner.finishClear(clear, input, true);
    expect(recovered).toEqual({
      attachments: [...steers, ...follows].map((item) => item.attachment),
    });
    expect(recovered.attachments).toHaveLength(10);
    for (const item of [...steers, ...follows])
      expect(
        (await store.imagePreview(item.attachment.id)).bytes.toString("base64"),
      ).toBe(item.image.data);
    // Retirement and a late prompt acceptance cannot invalidate transferred handles.
    await owner.dispose();
    for (const item of [...steers, ...follows]) {
      owner.accepted(item.delivery, "queued");
      await expect(
        store.imagePreview(item.attachment.id),
      ).resolves.toBeDefined();
      await store.remove(item.attachment.id);
      await expect(
        store.imagePreview(item.attachment.id),
      ).rejects.toMatchObject({ status: 404 });
    }
  });

  it("uses bytes to correct Pi's caption-only cross-mode consumption", async () => {
    const follow = await enqueue("followUp", "same", "follow image");
    const steer = await enqueue("steer", "same", "steer image");
    queue.steering = [];
    owner.observeQueue(queue); // Pi picks the Steer caption although Queue actually starts.
    owner.observeMessage(follow.message);
    const { clear, input } = boundary();
    expect(await owner.finishClear(clear, input, true)).toEqual({
      attachments: [steer.attachment],
    });
    await expect(
      store.imagePreview(follow.attachment.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      store.imagePreview(steer.attachment.id),
    ).resolves.toBeDefined();
  });

  it("does not restore consumed image-only input despite Pi's stale empty-text row", async () => {
    const consumed = await enqueue("steer", "", "first image");
    const pending = await enqueue("steer", "", "second image");
    expect(owner.observeMessage(consumed.message)).toBe(true);
    expect(owner.project()).toEqual({
      steering: [
        {
          text: "",
          imageCount: 1,
          imageAttachmentIds: [pending.attachment.id],
        },
      ],
      followUp: [],
    });
    const { clear, input } = boundary();
    expect(input.steering).toEqual(["", ""]);
    expect(owner.clearedInput(clear, input)).toEqual({
      steering: [""],
      followUp: [],
    });
    expect(await owner.finishClear(clear, input, true)).toEqual({
      attachments: [pending.attachment],
    });
  });

  it("keeps consumed-row evidence across settlement and later admissions, without labeling external rows", async () => {
    const consumed = await enqueue("steer", "", "first image");
    owner.observeMessage(consumed.message);
    owner.settled();
    const pending = await enqueue("steer", "", "second image");
    queue.followUp.push(""); // External Pi row, no Inspire-owned image evidence.
    owner.observeQueue(queue);
    expect(owner.project()).toEqual({
      steering: [
        {
          text: "",
          imageCount: 1,
          imageAttachmentIds: [pending.attachment.id],
        },
      ],
      followUp: [{ text: "" }],
    });
    const { clear, input } = boundary();
    expect(owner.clearedInput(clear, input)).toEqual({
      steering: [""],
      followUp: [""],
    });
    expect(await owner.finishClear(clear, input, true)).toEqual({
      attachments: [pending.attachment],
    });
    await expect(
      store.imagePreview(consumed.attachment.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(owner.project()).toEqual({ steering: [], followUp: [] });
  });

  it("preserves duplicate-image multiplicity while removing exactly one consumed message", async () => {
    const consumed = await enqueue("steer", "same", "same image");
    const pending = await enqueue("steer", "same", "same image");
    queue.steering.shift();
    owner.observeQueue(queue);
    owner.observeMessage(consumed.message);
    expect(owner.project()).toEqual({
      steering: [
        {
          text: "same",
          imageCount: 1,
          imageAttachmentIds: [pending.attachment.id],
        },
      ],
      followUp: [],
    });
    const { clear, input } = boundary();
    expect(await owner.finishClear(clear, input, true)).toEqual({
      attachments: [pending.attachment],
    });
  });

  it("attributes late input after the response fence to the next recovery", async () => {
    const first = await enqueue("followUp", "first", "first image");
    const firstClear = boundary();
    const late = await enqueue("followUp", "late", "late image");
    expect(
      await owner.finishClear(firstClear.clear, firstClear.input, true),
    ).toEqual({ attachments: [first.attachment] });
    const secondClear = boundary();
    expect(
      await owner.finishClear(secondClear.clear, secondClear.input, true),
    ).toEqual({ attachments: [late.attachment] });
  });

  it("corroborates appended consumption without double-consuming a later raw event", async () => {
    const follow = await enqueue("followUp", "same", "follow image");
    const steer = await enqueue("steer", "same", "steer image");
    queue.steering = [];
    owner.observeQueue(queue);
    const { clear, input } = boundary();
    messages = [follow.message];
    await owner.corroborate(clear);
    expect(await owner.finishClear(clear, input, true)).toEqual({
      attachments: [steer.attachment],
    });
    owner.observeMessage(follow.message);
    await expect(
      store.imagePreview(steer.attachment.id),
    ).resolves.toBeDefined();
  });

  it("recovers unchanged input while an unrelated identical-caption message_start is delayed", async () => {
    await enqueue("followUp", "same", "already starting image");
    queue.followUp = [];
    owner.observeQueue(queue); // No alternative same-caption row existed at consumption.
    const pending = await enqueue("steer", "same", "still pending image");
    const { clear, input } = boundary();
    await owner.corroborate(clear);
    expect(await owner.finishClear(clear, input, true)).toEqual({
      attachments: [pending.attachment],
    });
  });

  it("warns without guessing when a delayed start leaves genuine cross-mode image ambiguity", async () => {
    const follow = await enqueue("followUp", "same", "follow image");
    const steer = await enqueue("steer", "same", "steer image");
    queue.steering = [];
    owner.observeQueue(queue);
    const { clear, input } = boundary();
    await owner.corroborate(clear); // No appended or raw message proves consumption yet.
    expect(await owner.finishClear(clear, input, true)).toEqual({
      warning: expect.stringContaining("could not be correlated safely"),
    });
    for (const item of [follow, steer])
      await expect(
        store.imagePreview(item.attachment.id),
      ).rejects.toMatchObject({ status: 404 });
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
    const { clear, input } = boundary();
    expect(await owner.finishClear(clear, input, false)).toEqual({});
    for (const item of [upload, recalled])
      await expect(
        store.resolveForPrompt([item.attachment.id]),
      ).rejects.toMatchObject({ code: "ATTACHMENTS_EXPIRED" });
  });
});
