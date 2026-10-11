import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { pendingTextSummary } from "../../shared/pending-preview.js";

import {
  fixture,
  eventsOf,
  settled,
  disposeOperationFixture,
} from "./fixtures/native-operation.js";

afterEach(disposeOperationFixture);

describe("native Pending recovery", () => {
  it("recovers complete queued text without stopping and Stop never runs pending input", async () => {
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolveModel) => {
      releaseModel = resolveModel;
    });
    try {
      const f = await fixture(false, 0, modelGate);
      await f.api.prompt(f.delivery("Keep this synthetic task active."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      const longSteer = `${"long queued input ".repeat(200)}EXACT_END`;
      for (const [message, behavior] of [
        ["follow one", "followUp"],
        [longSteer, "steer"],
        ["steer two", "steer"],
        ["follow two", "followUp"],
      ] as const)
        await f.api.prompt({ ...f.delivery(message), behavior });
      const snapshot = await f.runtime.snapshot();
      expect(snapshot.pendingQueues!.totalCount).toBe(4);
      expect(snapshot.pendingQueues!.steering[0]!.textPreview).toHaveLength(
        512,
      );
      expect(snapshot.pendingQueues!.steering[0]!.textPreview).toMatch(
        /…\n.*EXACT_END$/,
      );
      const read = {
        sessionId: f.sessionId,
        viewId: snapshot.active!.transcriptPage.viewId,
        revision: snapshot.pendingQueues!.revision,
      };
      await expect(
        f.api.pendingText({ ...read, itemId: "text-steer-0" }),
      ).resolves.toEqual({ text: longSteer });
      await expect(f.api.pendingText(read)).resolves.toEqual({
        text: `1. ${longSteer}\n2. steer two\n3. follow one\n4. follow two`,
      });
      expect((await f.runtime.snapshot()).pendingQueues).toEqual(
        snapshot.pendingQueues,
      );
      const restored = await f.api.recoverPending(f.sessionId);
      expect(restored).toEqual({
        steering: [longSteer, "steer two"],
        followUp: ["follow one", "follow two"],
      });
      expect((await f.runtime.snapshot()).pendingQueues!.totalCount).toBe(0);
      expect((await f.runtime.snapshot()).runState).toBe("running");
      expect(f.workers[0]!.stop).not.toHaveBeenCalled();
      await f.api.prompt({
        ...f.delivery("Never run this after Stop."),
        behavior: "followUp",
      });
      await expect(f.api.abort(f.sessionId)).resolves.toEqual({
        steering: [],
        followUp: ["Never run this after Stop."],
      });
      await vi.waitFor(() =>
        expect(eventsOf(f.runtimeEvents, "agent_settled")).toHaveLength(1),
      );
      releaseModel();
      await delay(250);
      expect(f.modelRequests).toHaveLength(1);
      const state = await f.workers[0]!.request({ type: "get_state" });
      expect(state).toMatchObject({
        isStreaming: false,
        pendingMessageCount: 0,
      });
      expect(eventsOf(f.runtimeEvents, "runtime_error")).toEqual([]);
      expect(eventsOf(f.runtimeEvents, "session_projection_conflict")).toEqual(
        [],
      );
    } finally {
      releaseModel?.();
    }
  }, 30_000);

  it("recovers and resends mixed/duplicate/image-only input, discards copies, and restores both modes on Stop", async () => {
    let releaseModel!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseModel = resolveGate;
    });
    try {
      const f = await fixture(false, 0, gate);
      await f.api.prompt(
        f.delivery("Keep mixed pending-image recovery active."),
      );
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      );
      const gif = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      );
      const add = async (bytes: Buffer, name: string) =>
        f.attachments.add({
          originalname: name,
          mimetype: name.endsWith("png") ? "image/png" : "image/gif",
          size: bytes.length,
          buffer: bytes,
        } as Express.Multer.File);
      const first = await add(png, "first.png");
      const second = await add(gif, "second.gif");
      const duplicate = await add(png, "duplicate.png");
      const imageOnly = await add(gif, "image-only.gif");
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
      const recovered = await f.api.recoverPending(f.sessionId);
      expect(recovered).toEqual({
        steering: ["same caption", "same caption"],
        followUp: ["same caption", ""],
        attachments: [first, duplicate, second, imageOnly],
        authorityId: f.application.authorityId,
      });
      for (const image of recovered.attachments!)
        expect((await f.api.attachmentPreview(image.id)).size).toBe(image.size);
      const merged = [...recovered.steering, ...recovered.followUp].join(
        "\n\n",
      );
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
      const stopSteer = await add(png, "stop-steer.png");
      const stopFollow = await add(gif, "stop-follow.gif");
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
      expect(f.modelRequests).toHaveLength(1);
    } finally {
      releaseModel?.();
    }
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
      let releaseFirst!: () => void;
      let releaseLater!: () => void;
      const first = new Promise<void>((resolveGate) => {
        releaseFirst = resolveGate;
      });
      const later = new Promise<void>((resolveGate) => {
        releaseLater = resolveGate;
      });
      try {
        const f = await fixture(false, 0, (number) =>
          number === 1 ? first : later,
        );
        await f.api.prompt(f.delivery("Keep image-only consumption active."));
        await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
        const bytes = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
          "base64",
        );
        const image = await f.attachments.add({
          originalname: "consumed.png",
          mimetype: "image/png",
          size: bytes.length,
          buffer: bytes,
        } as Express.Multer.File);
        await f.api.prompt({
          ...f.delivery(caption),
          behavior: mode,
          attachmentIds: [image.id],
        });
        const admitted = await f.runtime.snapshot();
        expect(admitted.pendingQueues!.totalCount).toBe(1);
        const staleRead = {
          sessionId: f.sessionId,
          viewId: admitted.active!.transcriptPage.viewId,
          revision: admitted.pendingQueues!.revision,
          itemId: `text-${mode}-0`,
        };
        releaseFirst();
        await vi.waitFor(() => expect(f.modelRequests).toHaveLength(2));
        expect((await f.runtime.snapshot()).pendingQueues!.totalCount).toBe(0);
        expect(eventsOf(f.runtimeEvents, "queue_update").at(-1)).toMatchObject({
          pendingQueues: { totalCount: 0 },
        });
        await expect(f.api.pendingText(staleRead)).rejects.toMatchObject({
          status: 409,
        });
        const gif = Buffer.from(
          "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
          "base64",
        );
        const pending = await f.attachments.add({
          originalname: "pending.gif",
          mimetype: "image/gif",
          size: gif.length,
          buffer: gif,
        } as Express.Multer.File);
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
        expect(rows).toEqual([
          {
            id: `text-${mode}-0`,
            ...pendingTextSummary(caption),
            imageCount: 1,
            imageAttachmentIds: [pending.id],
          },
          {
            id: `text-${mode}-1`,
            textPreview: "later exact text",
            textLength: 16,
            textTruncated: false,
          },
        ]);
        const nativeQueue = eventsOf(f.piEvents, "queue_update").at(-1)!;
        expect(nativeQueue[mode === "steer" ? "steering" : "followUp"]).toEqual(
          caption
            ? [caption, "later exact text"]
            : ["", "", "later exact text"],
        );
        const read = {
          sessionId: f.sessionId,
          viewId: snapshot.active!.transcriptPage.viewId,
          revision: snapshot.pendingQueues!.revision,
        };
        expect(
          await f.api.pendingText({ ...read, itemId: rows[0]!.id }),
        ).toEqual({ text: caption });
        expect(
          await f.api.pendingText({ ...read, itemId: rows[1]!.id }),
        ).toEqual({ text: "later exact text" });
        expect(await f.api.pendingText(read)).toEqual({
          text: `1. ${caption}\n2. later exact text`,
        });
        const recovered = await f.api.recoverPending(f.sessionId);
        expect(recovered).toEqual({
          steering: mode === "steer" ? [caption, "later exact text"] : [],
          followUp: mode === "followUp" ? [caption, "later exact text"] : [],
          attachments: [pending],
          authorityId: f.application.authorityId,
        });
        expect((await f.api.attachmentPreview(pending.id)).size).toBe(
          gif.length,
        );
        await expect(f.api.attachmentPreview(image.id)).rejects.toMatchObject({
          status: 404,
        });
        const body = f.modelRequests[1]!.body;
        expect(JSON.stringify(body)).toContain("data:image/png;base64,");
        expect(JSON.stringify(body)).not.toContain("data:image/gif;base64,");
        expect((await f.runtime.snapshot()).pendingQueues!.totalCount).toBe(0);
        await f.api.abort(f.sessionId);
        expect(f.modelRequests).toHaveLength(2);
      } finally {
        releaseFirst?.();
        releaseLater?.();
      }
    },
    30_000,
  );

  it("keeps consumed image-only captions hidden after settlement and the next native queue update", async () => {
    const releases: Array<() => void> = [];
    const gates = Array.from(
      { length: 3 },
      () =>
        new Promise<void>((resolveGate) => {
          releases.push(resolveGate);
        }),
    );
    try {
      const f = await fixture(false, 0, (number) => gates[number - 1]!);
      await f.api.prompt(f.delivery("First synthetic task."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      );
      const add = (name: string) =>
        f.attachments.add({
          originalname: name,
          mimetype: "image/png",
          size: bytes.length,
          buffer: bytes,
        } as Express.Multer.File);
      const consumed = await add("consumed.png");
      await f.api.prompt({
        ...f.delivery(""),
        behavior: "steer",
        attachmentIds: [consumed.id],
      });
      releases[0]!();
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(2));
      releases[1]!();
      await settled(f, 1);
      expect((await f.runtime.snapshot()).pendingQueues!.totalCount).toBe(0);
      // No recovery or clear has removed Pi's stale native caption.
      expect(eventsOf(f.piEvents, "queue_update").at(-1)).toMatchObject({
        steering: [""],
        followUp: [],
      });
      await f.api.prompt(f.delivery("Second synthetic task."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(3));
      const pending = await add("pending.png");
      await f.api.prompt({
        ...f.delivery(""),
        behavior: "steer",
        attachmentIds: [pending.id],
      });
      expect(eventsOf(f.piEvents, "queue_update").at(-1)).toMatchObject({
        steering: ["", ""],
      });
      expect((await f.runtime.snapshot()).pendingQueues).toMatchObject({
        totalCount: 1,
        steering: [{ id: "text-steer-0", textPreview: "", imageCount: 1 }],
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
      expect((await f.api.attachmentPreview(pending.id)).size).toBe(
        bytes.length,
      );
      expect(f.modelRequests).toHaveLength(3);
      expect(f.workers).toHaveLength(1);
      expect(f.workers[0]!.stop).not.toHaveBeenCalled();
    } finally {
      for (const release of releases) release();
    }
  }, 30_000);

  it("recovers unchanged pending images while an extension delays message_start; get_messages does not expose that in-flight message", async () => {
    let releaseFirst!: () => void;
    let releaseLater!: () => void;
    const first = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const later = new Promise<void>((resolveGate) => {
      releaseLater = resolveGate;
    });
    try {
      const f = await fixture(false, 0, (number) =>
        number === 1 ? first : later,
      );
      await f.api.prompt(
        f.delivery("Keep delayed image event recovery active."),
      );
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      );
      const gif = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      );
      const consumed = await f.attachments.add({
        originalname: "starting.png",
        mimetype: "image/png",
        size: png.length,
        buffer: png,
      } as Express.Multer.File);
      await f.api.prompt({
        ...f.delivery("Delay unchanged image start."),
        behavior: "steer",
        attachmentIds: [consumed.id],
      });
      releaseFirst();
      await vi.waitFor(async () =>
        expect(
          (await f.runtime.snapshot()).pendingExtensionUiRequests,
        ).toHaveLength(1),
      );
      const dialog = (await f.runtime.snapshot())
        .pendingExtensionUiRequests![0]!;
      const publicMessages = await f.workers[0]!.request<{
        messages: unknown[];
      }>({ type: "get_messages" });
      expect(JSON.stringify(publicMessages.messages)).not.toContain(
        png.toString("base64"),
      );
      const pending = await f.attachments.add({
        originalname: "pending.gif",
        mimetype: "image/gif",
        size: gif.length,
        buffer: gif,
      } as Express.Multer.File);
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
      expect((await f.api.attachmentPreview(pending.id)).size).toBe(
        pending.size,
      );
      await expect(f.api.attachmentPreview(consumed.id)).rejects.toMatchObject({
        status: 404,
      });
      await f.api.abort(f.sessionId);
      expect((await f.api.attachmentPreview(pending.id)).size).toBe(
        pending.size,
      );
    } finally {
      releaseFirst?.();
      releaseLater?.();
    }
  }, 30_000);

  it("recovers original Inspire bytes across an invisible same-caption image replacement, but not after Pi consumes that input", async () => {
    let releaseFirst!: () => void;
    let releaseLater!: () => void;
    const first = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const later = new Promise<void>((resolveGate) => {
      releaseLater = resolveGate;
    });
    try {
      const f = await fixture(false, 0, (number) =>
        number === 1 ? first : later,
      );
      await f.api.prompt(f.delivery("Keep replacement recovery active."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      );
      const image = await f.attachments.add({
        originalname: "original.png",
        mimetype: "image/png",
        size: bytes.length,
        buffer: bytes,
      } as Express.Multer.File);
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
      ).toEqual(bytes);
      await f.api.prompt({
        ...f.delivery("Replace pending image bytes."),
        behavior: "followUp",
        attachmentIds: [image.id],
      });
      releaseFirst();
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
    } finally {
      releaseFirst?.();
      releaseLater?.();
    }
  }, 30_000);
});
