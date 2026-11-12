import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  disposeOperationFixture,
  eventsOf,
  fixture,
  settled,
} from "./fixtures/native-operation.js";
import { deferredSignal } from "./fixtures/runtime.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const gif = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

function addImage(f: Awaited<ReturnType<typeof fixture>>, name: string) {
  const isGif = name.endsWith(".gif");
  const bytes = isGif ? gif : png;
  return f.attachments.add({
    originalname: name,
    mimetype: isGif ? "image/gif" : "image/png",
    size: bytes.length,
    buffer: bytes,
  } as Express.Multer.File);
}

const releaseRuns: Array<() => void> = [];
afterEach(async () => {
  for (const release of releaseRuns.splice(0)) release();
  await disposeOperationFixture();
});

async function pendingRun() {
  const first = deferredSignal();
  const later = deferredSignal();
  releaseRuns.push(first.resolve, later.resolve);
  const f = await fixture(false, 0, (number) =>
    number === 1 ? first.promise : later.promise,
  );
  await f.api.prompt(f.delivery("Hold the first model request open."));
  await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
  return { ...f, finishFirst: first.resolve };
}

describe("native Pending recovery", () => {
  it.each(["recover", "abort"] as const)(
    "reclaims %s text and image ownership after a lost HTTP result without touching later native input",
    async (action) => {
      const f = await pendingRun();
      const image = await addImage(f, "pending.png");
      await f.api.prompt({
        ...f.delivery("original caption"),
        behavior: "followUp",
        attachmentIds: [image.id],
      });
      const identity = {
        operationId: randomUUID(),
        authorityId: f.application.authorityId,
      };
      const fetch = globalThis.fetch;
      let lost = false;
      vi.stubGlobal("fetch", (async (input, init) => {
        const response = await fetch(input, init);
        if (
          !lost &&
          String(input).endsWith(
            action === "recover"
              ? "/api/pending/recover"
              : "/api/control/abort",
          )
        ) {
          lost = true;
          throw new TypeError("fixture response connection lost after commit");
        }
        return response;
      }) satisfies typeof fetch);
      const mutate = () =>
        action === "recover"
          ? f.api.recoverPending(f.sessionId, identity)
          : f.api.abort(f.sessionId, identity);
      await expect(mutate()).rejects.toThrow();
      expect(lost).toBe(true);
      if (action === "abort") {
        await f.api.prompt(f.delivery("A later independent run."));
        await vi.waitFor(() => expect(f.modelRequests).toHaveLength(2));
      }
      await f.api.prompt({
        ...f.delivery("later input stays queued"),
        behavior: "followUp",
      });
      const recovered = await f.api.pendingOperation({
        ...identity,
        sessionId: f.sessionId,
        action,
      });
      expect(recovered).toEqual({
        steering: [],
        followUp: ["original caption"],
        attachments: [image],
        authorityId: identity.authorityId,
      });
      expect(await mutate()).toEqual(recovered);
      expect(
        Buffer.from(
          await (await f.api.attachmentPreview(image.id)).arrayBuffer(),
        ),
      ).toEqual(png);
      expect((await f.runtime.snapshot()).pendingQueues?.followUp).toEqual([
        expect.objectContaining({ textPreview: "later input stays queued" }),
      ]);
      expect((await f.runtime.snapshot()).runState).toBe("running");
    },
    30_000,
  );

  it("copies, returns, resends and clears mixed native input before recovering both modes on Stop", async () => {
    const f = await pendingRun();
    const first = await addImage(f, "first.png");
    const second = await addImage(f, "second.gif");
    const duplicate = await addImage(f, "duplicate.png");
    const imageOnly = await addImage(f, "image-only.gif");
    for (const [image, behavior, text] of [
      [first, "steer", "same caption"],
      [second, "followUp", "same caption"],
      [duplicate, "steer", "same caption"],
      [imageOnly, "followUp", ""],
    ] as const)
      await f.api.prompt({
        ...f.delivery(text),
        behavior,
        attachmentIds: [image.id],
      });
    const longText = `${"long queued input ".repeat(200)}EXACT_END`;
    await f.api.prompt({ ...f.delivery(longText), behavior: "steer" });
    const { active, pendingQueues } = await f.runtime.snapshot();
    const read = {
      sessionId: f.sessionId,
      viewId: active!.transcriptPage.viewId,
      revision: pendingQueues!.revision,
    };
    expect(
      await f.api.pendingText({
        ...read,
        itemId: pendingQueues!.steering[2]!.id,
      }),
    ).toEqual({ text: longText });
    const images = [first, duplicate, second, imageOnly];
    expect(await f.api.pendingText(read)).toEqual({
      text: `1. same caption\n2. same caption\n3. ${longText}\n4. same caption\n5. `,
      imageAttachmentIds: images.map(({ id }) => id),
    });
    expect((await f.runtime.snapshot()).pendingQueues).toEqual(pendingQueues);
    const recovered = await f.api.recoverPending(f.sessionId);
    expect(recovered).toEqual({
      steering: ["same caption", "same caption", longText],
      followUp: ["same caption", ""],
      attachments: images,
      authorityId: f.application.authorityId,
    });
    expect(await f.runtime.snapshot()).toMatchObject({
      pendingQueues: { totalCount: 0 },
      runState: "running",
    });
    for (const image of recovered.attachments!)
      expect((await f.api.attachmentPreview(image.id)).size).toBe(image.size);
    const merged = [...recovered.steering, ...recovered.followUp].join("\n\n");
    await f.api.prompt({
      ...f.delivery(merged),
      behavior: "followUp",
      attachmentIds: recovered.attachments!.map((image) => image.id),
    });
    expect(
      (await f.runtime.snapshot()).pendingQueues!.followUp[0],
    ).toMatchObject({
      imageCount: 4,
      textLength: merged.trim().length,
    });
    await f.api.clearPending(f.sessionId);
    for (const image of recovered.attachments!)
      await expect(f.api.attachmentPreview(image.id)).rejects.toMatchObject({
        status: 404,
      });
    const stopSteer = await addImage(f, "stop-steer.png");
    const stopFollow = await addImage(f, "stop-follow.gif");
    await f.api.prompt({
      ...f.delivery("stop caption"),
      behavior: "steer",
      attachmentIds: [stopSteer.id],
    });
    await f.api.prompt({
      ...f.delivery(""),
      behavior: "followUp",
      attachmentIds: [stopFollow.id],
    });
    expect(await f.api.abort(f.sessionId)).toEqual({
      steering: ["stop caption"],
      followUp: [""],
      attachments: [stopSteer, stopFollow],
      authorityId: f.application.authorityId,
    });
    for (const image of [stopSteer, stopFollow])
      expect((await f.api.attachmentPreview(image.id)).size).toBe(image.size);
    await vi.waitFor(() =>
      expect(eventsOf(f.runtimeEvents, "agent_settled")).toHaveLength(1),
    );
    expect(await f.workers[0]!.request({ type: "get_state" })).toMatchObject({
      isStreaming: false,
      pendingMessageCount: 0,
    });
    expect(f.modelRequests).toHaveLength(1);
  }, 30_000);

  it.each([
    { label: "image-only Steer", mode: "steer", caption: "" },
    { label: "image-only Queue", mode: "followUp", caption: "" },
    {
      label: "same-caption Queue",
      mode: "followUp",
      caption: "long same caption ".repeat(40).trim(),
    },
  ] as const)(
    "keeps only unconsumed $label content through projection, full copy and recovery",
    async ({ mode, caption }) => {
      const f = await pendingRun();
      const image = await addImage(f, "consumed.png");
      await f.api.prompt({
        ...f.delivery(caption),
        behavior: mode,
        attachmentIds: [image.id],
      });
      const admitted = await f.runtime.snapshot();
      expect(admitted.pendingQueues!.totalCount).toBe(1);
      const firstRow =
        mode === "steer"
          ? admitted.pendingQueues!.steering[0]!
          : admitted.pendingQueues!.followUp[0]!;
      const staleRead = {
        sessionId: f.sessionId,
        viewId: admitted.active!.transcriptPage.viewId,
        revision: admitted.pendingQueues!.revision,
        itemId: firstRow.id,
      };
      f.finishFirst();
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(2));
      expect((await f.runtime.snapshot()).pendingQueues!.totalCount).toBe(0);
      expect(eventsOf(f.runtimeEvents, "queue_update").at(-1)).toMatchObject({
        pendingQueues: { totalCount: 0 },
      });
      await expect(f.api.pendingText(staleRead)).rejects.toMatchObject({
        status: 409,
      });
      const pending = await addImage(f, "pending.gif");
      await f.api.prompt({
        ...f.delivery(caption),
        behavior: mode,
        attachmentIds: [pending.id],
      });
      await f.api.prompt({
        ...f.delivery("later exact text"),
        behavior: mode,
      });
      const snapshot = await f.runtime.snapshot();
      expect(snapshot.runState).toBe("running");
      expect(snapshot.pendingQueues!.totalCount).toBe(2);
      const rows =
        mode === "steer"
          ? snapshot.pendingQueues!.steering
          : snapshot.pendingQueues!.followUp;
      expect(rows).toMatchObject([
        { imageCount: 1, imageAttachmentIds: [pending.id] },
        { textPreview: "later exact text" },
      ]);
      const read = {
        sessionId: f.sessionId,
        viewId: snapshot.active!.transcriptPage.viewId,
        revision: snapshot.pendingQueues!.revision,
      };
      expect(await f.api.pendingText({ ...read, itemId: rows[0]!.id })).toEqual(
        { text: caption, imageAttachmentIds: [pending.id] },
      );
      expect(await f.api.pendingText({ ...read, itemId: rows[1]!.id })).toEqual(
        { text: "later exact text" },
      );
      expect(await f.api.pendingText(read)).toEqual({
        text: `1. ${caption}\n2. later exact text`,
        imageAttachmentIds: [pending.id],
      });
      const recovered = await f.api.recoverPending(f.sessionId);
      expect(recovered).toEqual({
        steering: mode === "steer" ? [caption, "later exact text"] : [],
        followUp: mode === "followUp" ? [caption, "later exact text"] : [],
        attachments: [pending],
        authorityId: f.application.authorityId,
      });
      expect((await f.api.attachmentPreview(pending.id)).size).toBe(gif.length);
      await expect(f.api.attachmentPreview(image.id)).rejects.toMatchObject({
        status: 404,
      });
      const body = f.modelRequests[1]!.body;
      expect(JSON.stringify(body)).toContain("data:image/png;base64,");
      expect(JSON.stringify(body)).not.toContain("data:image/gif;base64,");
      expect((await f.runtime.snapshot()).pendingQueues!.totalCount).toBe(0);
      await f.api.abort(f.sessionId);
      expect(f.modelRequests).toHaveLength(2);
    },
    30_000,
  );

  it("keeps consumed image-only input out of Pending after settlement and later admissions", async () => {
    const gates = [deferredSignal(), deferredSignal(), deferredSignal()];
    try {
      const f = await fixture(false, 0, (number) => gates[number - 1]!.promise);
      await f.api.prompt(f.delivery("First synthetic task."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      const consumed = await addImage(f, "consumed.png");
      await f.api.prompt({
        ...f.delivery(""),
        behavior: "steer",
        attachmentIds: [consumed.id],
      });
      gates[0]!.resolve();
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(2));
      gates[1]!.resolve();
      await settled(f, 1);
      expect((await f.runtime.snapshot()).pendingQueues!.totalCount).toBe(0);
      await f.api.prompt(f.delivery("Second synthetic task."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(3));
      const pending = await addImage(f, "pending.png");
      await f.api.prompt({
        ...f.delivery(""),
        behavior: "steer",
        attachmentIds: [pending.id],
      });
      expect((await f.runtime.snapshot()).pendingQueues).toMatchObject({
        totalCount: 1,
        steering: [{ textPreview: "", imageAttachmentIds: [pending.id] }],
        followUp: [],
      });
      expect(await f.api.abort(f.sessionId)).toEqual({
        steering: [""],
        followUp: [],
        attachments: [pending],
        authorityId: f.application.authorityId,
      });
      await expect(f.api.attachmentPreview(consumed.id)).rejects.toMatchObject({
        status: 404,
      });
      expect((await f.api.attachmentPreview(pending.id)).size).toBe(png.length);
      expect(f.modelRequests).toHaveLength(3);
      expect(f.workers).toHaveLength(1);
      expect(f.workers[0]!.stop).not.toHaveBeenCalled();
    } finally {
      for (const gate of gates) gate.resolve();
    }
  }, 30_000);

  it("recovers unchanged pending images while an extension delays message_start; get_messages does not expose that in-flight message", async () => {
    const f = await pendingRun();
    const consumed = await addImage(f, "starting.png");
    await f.api.prompt({
      ...f.delivery("Delay unchanged image start."),
      behavior: "steer",
      attachmentIds: [consumed.id],
    });
    f.finishFirst();
    await vi.waitFor(async () =>
      expect(
        (await f.runtime.snapshot()).pendingExtensionUiRequests,
      ).toHaveLength(1),
    );
    const dialog = (await f.runtime.snapshot()).pendingExtensionUiRequests![0]!;
    const publicMessages = await f.workers[0]!.request<{
      messages: unknown[];
    }>({ type: "get_messages" });
    expect(JSON.stringify(publicMessages.messages)).not.toContain(
      png.toString("base64"),
    );
    const pending = await addImage(f, "pending.gif");
    await f.api.prompt({
      ...f.delivery("Delay unchanged image start."),
      behavior: "followUp",
      attachmentIds: [pending.id],
    });
    expect(await f.api.recoverPending(f.sessionId)).toEqual({
      steering: [],
      followUp: ["Delay unchanged image start."],
      attachments: [pending],
      authorityId: f.application.authorityId,
    });
    await f.runtime.extensionUiResponse({
      sessionId: f.sessionId,
      id: dialog.id,
      confirmed: true,
    });
    await vi.waitFor(() => expect(f.modelRequests).toHaveLength(2));
    expect((await f.api.attachmentPreview(pending.id)).size).toBe(pending.size);
    await expect(f.api.attachmentPreview(consumed.id)).rejects.toMatchObject({
      status: 404,
    });
    await f.api.abort(f.sessionId);
    expect((await f.api.attachmentPreview(pending.id)).size).toBe(pending.size);
  }, 30_000);

  it("recovers original Inspire bytes across an invisible same-caption image replacement, but not after Pi consumes that input", async () => {
    const f = await pendingRun();
    const image = await addImage(f, "original.png");
    await f.api.prompt({
      ...f.delivery("Replace pending image bytes."),
      behavior: "followUp",
      attachmentIds: [image.id],
    });
    expect(await f.api.recoverPending(f.sessionId)).toEqual({
      steering: [],
      followUp: ["Replace pending image bytes."],
      attachments: [image],
      authorityId: f.application.authorityId,
    });
    expect(
      Buffer.from(
        await (await f.api.attachmentPreview(image.id)).arrayBuffer(),
      ),
    ).toEqual(png);
    await f.api.prompt({
      ...f.delivery("Replace pending image bytes."),
      behavior: "followUp",
      attachmentIds: [image.id],
    });
    f.finishFirst();
    await vi.waitFor(() => expect(f.modelRequests).toHaveLength(2));
    expect(JSON.stringify(f.modelRequests[1]!.body)).toContain(
      "data:image/gif;base64,",
    );
    const recovered = await f.api.recoverPending(f.sessionId);
    expect(recovered.attachments).toBeUndefined();
    expect(recovered.warning).toBeUndefined();
    await expect(f.api.attachmentPreview(image.id)).rejects.toMatchObject({
      status: 404,
    });
    await f.api.abort(f.sessionId);
  }, 30_000);
});
