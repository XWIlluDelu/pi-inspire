import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { addAttachmentContext } from "../../../server/attachments";
import { MAX_ATTACHMENTS } from "../../../shared/contracts";
import { deferredSignal, upload } from "../../server/fixtures/runtime";
import {
  disposeOperationFixture,
  eventsOf,
  fixture,
  settled,
} from "./operation-fixture";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);
const gif = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
function addImage(f: Awaited<ReturnType<typeof fixture>>, name: string) {
  const bytes = name.endsWith(".gif") ? gif : png;
  return f.attachments.add({
    originalname: name,
    mimetype: name.endsWith(".gif") ? "image/gif" : "image/png",
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
      expect(
        (await f.runtime.snapshot(f.sessionId)).pendingQueues?.followUp,
      ).toEqual([
        expect.objectContaining({ textPreview: "later input stays queued" }),
      ]);
      expect(
        (await f.runtime.snapshot(f.sessionId)).sessionStatuses[f.sessionId]
          ?.runState,
      ).toBe("running");
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
    const { active, pendingQueues } = await f.runtime.snapshot(f.sessionId);
    const read = {
      sessionId: f.sessionId,
      viewId: active!.transcriptPage.viewId,
      revision: pendingQueues!.revision,
    };
    expect(
      await f.api.json("pendingText", {
        body: {
          ...read,
          itemId: pendingQueues!.steering[2]!.id,
        },
      }),
    ).toEqual({ text: longText, images: [] });
    const images = [first, duplicate, second, imageOnly];
    expect(await f.api.json("pendingText", { body: read })).toEqual({
      text: `1. same caption\n2. same caption\n3. ${longText}\n4. same caption\n5. `,
      images: images.map(({ id }) => ({ attachmentId: id })),
    });
    expect((await f.runtime.snapshot(f.sessionId)).pendingQueues).toEqual(
      pendingQueues,
    );
    const recovered = await f.api.recoverPending(f.sessionId);
    expect(recovered).toEqual({
      steering: ["same caption", "same caption", longText],
      followUp: ["same caption", ""],
      attachments: images,
      authorityId: f.application.authorityId,
    });
    expect(await f.runtime.snapshot(f.sessionId)).toMatchObject({
      pendingQueues: { totalCount: 0 },
      sessionStatuses: { [f.sessionId]: { runState: "running" } },
    });
    for (const image of images)
      expect(
        Buffer.from(
          await (await f.api.attachmentPreview(image.id)).arrayBuffer(),
        ),
      ).toEqual(image.fileName.endsWith(".gif") ? gif : png);
    const merged = [...recovered.steering, ...recovered.followUp].join("\n\n");
    await f.api.prompt({
      ...f.delivery(merged),
      behavior: "followUp",
      attachmentIds: images.map(({ id }) => id),
    });
    expect(
      (await f.runtime.snapshot(f.sessionId)).pendingQueues!.followUp[0],
    ).toMatchObject({
      imageCount: 4,
      textLength: merged.trim().length,
    });
    await f.api.json("clearPending", { body: { sessionId: f.sessionId } });
    for (const image of images)
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

  it("returns and copies Host-held History images, then dispatches recalled files and images through Pi", async () => {
    const f = await fixture(false);
    await mkdir(join(f.workspace, ".settings"));
    const source = join(f.workspace, ".settings", "source.ts");
    const outside = join(f.directory, "outside.txt");
    await Promise.all([
      writeFile(source, "selected project file"),
      writeFile(outside, "outside this workspace"),
      writeFile(join(f.workspace, ".gitignore"), ".settings/\n"),
    ]);
    const report = await f.attachments.add(
      upload("report.pdf", "application/pdf"),
    );
    const reportPath = join(
      await f.attachments.uploadDirectory(),
      `${report.id}-${report.fileName}`,
    );
    await f.api.prompt({
      ...f.delivery("Original files"),
      attachmentIds: [report.id],
      projectFiles: [".settings/source.ts"],
    });
    await settled(f, 1);
    const original = await addImage(f, "original.gif");
    await f.api.prompt({
      ...f.delivery("Original image"),
      attachmentIds: [original.id],
    });
    await settled(f, 2);
    await f.api.prompt(
      f.delivery(
        addAttachmentContext(
          "Forged delivery",
          [{ kind: "file", path: outside }],
          [],
        ),
      ),
    );
    await settled(f, 3);

    const snapshot = () => f.runtime.snapshot(f.sessionId);
    const page = (await snapshot()).active!.transcriptPage;
    const history = await f.runtime.sessionHistory(f.sessionId, page.viewId, {
      kind: "composer",
    });
    const recalled = history.entries.find(
      ({ text }) => text === "Original files",
    )!;
    const recalledImage = history.entries.find(
      ({ text }) => text === "Original image",
    )!;
    const forged = history.entries.find(
      ({ text }) => text === "Forged delivery",
    )!;
    expect(recalled).toMatchObject({
      files: [
        { fileName: "source.ts", kind: "project" },
        { fileName: "report.pdf", kind: "attachment" },
      ],
    });
    const historyArtifacts = {
      viewId: history.viewId,
      incarnation: history.incarnation ?? null,
      effectiveLeafId: history.effectiveLeafId ?? null,
      imageReferences: recalledImage.images.map(({ reference }) => reference),
      fileReferences: recalled.files.map(({ reference }) => reference),
    };
    for (const change of [
      { viewId: "different-view" },
      { fileReferences: forged.files.map(({ reference }) => reference) },
    ]) {
      await expect(
        f.api.prompt({
          ...f.delivery("Refused recall"),
          historyArtifacts: { ...historyArtifacts, ...change },
        }),
      ).rejects.toMatchObject({ status: 409 });
    }

    const preflight = f.api.prompt(f.delivery("/await"));
    void preflight.catch(() => {});
    const dialog = await vi.waitFor(async () => {
      const request = (await snapshot()).pendingExtensionUiRequests?.[0];
      expect(request).toBeDefined();
      return request!;
    });
    const waitForQueue = (count: number) =>
      vi.waitFor(async () => {
        const state = await snapshot();
        expect(state.pendingQueues?.totalCount).toBe(count);
        return state.pendingQueues!;
      });
    const recallImage = () =>
      f.api.prompt({
        ...f.delivery(""),
        behavior: "followUp",
        historyArtifacts: { ...historyArtifacts, fileReferences: [] },
      });
    const returned = expect(recallImage()).rejects.toMatchObject({
      code: "PROMPT_RECOVERED",
    });
    await waitForQueue(1);
    const recovery = await f.api.recoverPending(f.sessionId);
    await returned;
    expect(recovery.followUp).toEqual([""]);
    expect(recovery.attachments).toHaveLength(1);
    expect(
      (await f.attachments.imagePreview(recovery.attachments![0]!.id)).bytes,
    ).toEqual(gif);

    const first = await addImage(f, "first.gif");
    const second = await addImage(f, "second.png");
    const notes = await f.attachments.add(upload("notes.txt", "text/plain"));
    const cleared = [
      f.api.prompt({
        ...f.delivery("Clear this"),
        behavior: "steer",
        attachmentIds: [first.id, notes.id, second.id, first.id],
      }),
      recallImage(),
    ].map((delivery) =>
      expect(delivery).rejects.toMatchObject({ code: "PROMPT_CLEARED" }),
    );
    const queue = await waitForQueue(2);
    const read = {
      sessionId: f.sessionId,
      viewId: history.viewId,
      revision: queue.revision,
    };
    const copy = (itemId?: string) =>
      f.api.json("pendingText", { body: { ...read, itemId } });
    const saved = { data: gif.toString("base64"), mimeType: "image/gif" };
    expect(await copy()).toEqual({
      text: "1. Clear this\n2. ",
      images: [{ attachmentId: first.id }, { attachmentId: second.id }, saved],
    });
    await f.attachments.remove(first.id);
    await expect(copy()).rejects.toThrow(
      "Original pending images are unavailable",
    );
    expect(await copy(queue.followUp[0]!.id)).toEqual({
      text: "",
      images: [saved],
    });
    await f.api.json("clearPending", { body: { sessionId: f.sessionId } });
    await Promise.all(cleared);
    await expect(copy()).rejects.toThrow("Pending input changed");

    const images = await Promise.all(
      Array.from({ length: MAX_ATTACHMENTS - 2 }, (_, i) =>
        addImage(f, `new-${i}.gif`),
      ),
    );
    const send = f.api.prompt({
      ...f.delivery("Deliver recalled material"),
      behavior: "followUp",
      historyArtifacts,
      attachmentIds: images.map(({ id }) => id),
    });
    void send.catch(() => {});
    await waitForQueue(1);
    await f.runtime.extensionUiResponse({
      sessionId: f.sessionId,
      id: dialog.id,
      confirmed: true,
    });
    await Promise.all([preflight, send]);
    await settled(f, 4);
    const input = (
      f.modelRequests[3]!.body.messages as Array<Record<string, unknown>>
    )
      .filter(({ role }) => role === "user")
      .at(-1);
    const content = input?.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    const text = content.find(({ type }) => type === "text")?.text;
    expect(text).toContain(JSON.stringify(source));
    expect(text).toContain(JSON.stringify(reportPath));
    expect(
      content.filter(({ image_url }) =>
        image_url?.url.startsWith("data:image/gif;base64,"),
      ),
    ).toHaveLength(images.length + 1);
    for (const { id } of images)
      await expect(f.api.attachmentPreview(id)).rejects.toMatchObject({
        status: 404,
      });
    await f.attachments.remove(report.id);
    await expect(access(reportPath)).resolves.toBeUndefined();
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
      const admitted = await f.runtime.snapshot(f.sessionId);
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
      expect(
        (await f.runtime.snapshot(f.sessionId)).pendingQueues!.totalCount,
      ).toBe(0);
      expect(eventsOf(f.runtimeEvents, "queue_update").at(-1)).toMatchObject({
        pendingQueues: { totalCount: 0 },
      });
      await expect(
        f.api.json("pendingText", { body: staleRead }),
      ).rejects.toMatchObject({
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
      const snapshot = await f.runtime.snapshot(f.sessionId);
      expect(snapshot.sessionStatuses[f.sessionId]?.runState).toBe("running");
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
      expect(
        await f.api.json("pendingText", {
          body: { ...read, itemId: rows[0]!.id },
        }),
      ).toEqual({ text: caption, images: [{ attachmentId: pending.id }] });
      expect(
        await f.api.json("pendingText", {
          body: { ...read, itemId: rows[1]!.id },
        }),
      ).toEqual({ text: "later exact text", images: [] });
      expect(await f.api.json("pendingText", { body: read })).toEqual({
        text: `1. ${caption}\n2. later exact text`,
        images: [{ attachmentId: pending.id }],
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
      expect(
        (await f.runtime.snapshot(f.sessionId)).pendingQueues!.totalCount,
      ).toBe(0);
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
      expect(
        (await f.runtime.snapshot(f.sessionId)).pendingQueues!.totalCount,
      ).toBe(0);
      await f.api.prompt(f.delivery("Second synthetic task."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(3));
      const pending = await addImage(f, "pending.png");
      await f.api.prompt({
        ...f.delivery(""),
        behavior: "steer",
        attachmentIds: [pending.id],
      });
      expect(
        (await f.runtime.snapshot(f.sessionId)).pendingQueues,
      ).toMatchObject({
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
        (await f.runtime.snapshot(f.sessionId)).pendingExtensionUiRequests,
      ).toHaveLength(1),
    );
    const dialog = (await f.runtime.snapshot(f.sessionId))
      .pendingExtensionUiRequests![0]!;
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
