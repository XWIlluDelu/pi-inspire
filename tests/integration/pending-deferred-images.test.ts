// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptRequest, UploadedAttachment } from "../../shared/contracts";
import { deleteSessionDraft } from "../../src/session-drafts";
import {
  disposeRuntimeFixture,
  initializeRuntimeFixture,
  schedulingRuntime,
  trackedAttachmentStore,
  upload,
  waitForReady,
} from "../server/fixtures/runtime";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  TEST_HOST_AUTHORITY,
} from "../web/helpers";
import { baseRoutes, initStore } from "../web/store-fixture";

beforeEach(async () => {
  await initializeRuntimeFixture();
  installFakeWebSocket();
  deleteSessionDraft("a");
});
afterEach(disposeRuntimeFixture);

describe("Host-deferred image handoff", () => {
  it.each([
    ["sender", "caption", "compensation-first"],
    ["sender", "", "receipt-first"],
    ["other", "caption", "receipt-first"],
    ["other", "", "compensation-first"],
  ])(
    "restores %s's draft with %j (%s), using the same handles once",
    async (observer, caption, order) => {
      const attachments = trackedAttachmentStore();
      const f = schedulingRuntime({ attachments });
      const promptGate = deferred<void>();
      let sending!: Promise<unknown>;
      let returned: UploadedAttachment[] = [];
      try {
        await f.runtime.openSession("a");
        await waitForReady(f.runtime);
        const image = await attachments.add(
          upload("original.png", "image/png"),
        );
        const original = await attachments.imagePreview(image.id);
        f.worker.emit("event", { type: "compaction_start", reason: "auto" });
        f.worker.responseOverrides.set("get_state", () => ({
          sessionId: "a",
          isCompacting: true,
          isStreaming: false,
        }));
        installFetch(async (url, init) => {
          if (url.startsWith("/api/bootstrap"))
            return {
              body: bootstrapPayload({
                snapshot: {
                  ...activeSnapshot({ sessionId: "a" }),
                  runState: "compacting",
                },
              }),
            };
          if (url === "/api/attachments")
            return { body: { attachments: [image] } };
          if (url.endsWith("/image")) {
            await attachments.imagePreview(image.id);
            return { body: "image preview" };
          }
          if (url === "/api/prompt") {
            try {
              await f.runtime.prompt(
                jsonBody(init) as unknown as PromptRequest,
              );
              return {
                status: 202,
                body: { accepted: true, historyEntry: null },
              };
            } catch (error) {
              if (order === "receipt-first") await promptGate.promise;
              const recovered = error as Error & {
                code: string;
                recoveredAttachments: UploadedAttachment[];
                recoveryId?: string;
              };
              return {
                status: 409,
                headers: { "X-Inspire-Authority": TEST_HOST_AUTHORITY },
                body: {
                  error: recovered.message,
                  code: recovered.code,
                  recoveredAttachments: recovered.recoveredAttachments,
                  recoveryId: recovered.recoveryId,
                },
              };
            }
          }
          if (url === "/api/pending/recover") {
            const recovered = await f.runtime.recoverPending("a");
            returned = recovered.attachments ?? [];
            if (order === "compensation-first") await sending;
            return { body: { ...recovered, authorityId: TEST_HOST_AUTHORITY } };
          }
          return baseRoutes(url, init);
        });
        const sender = (await initStore()).store;
        const recipient =
          observer === "sender" ? sender : (await initStore()).store;
        await sender.addFiles([
          new File(["pixels"], "original.png", { type: "image/png" }),
        ]);
        sending = sender.sendPrompt(caption, "followUp");
        await vi.waitFor(async () =>
          expect((await f.runtime.snapshot()).pendingQueues?.totalCount).toBe(
            1,
          ),
        );
        expect(await recipient.recoverPending()).toBe(true);
        promptGate.resolve();
        expect(await sending).toBe(false);
        expect(returned).toEqual([image]);
        for (const store of new Set([sender, recipient])) {
          expect(
            store.getState().attachments.map((item) => item.uploadedId),
          ).toEqual([image.id]);
          expect(store.getState().attachments[0]?.status).toBe("ready");
        }
        expect((await f.runtime.snapshot()).pendingQueues?.totalCount).toBe(0);
        expect((await attachments.imagePreview(image.id)).bytes).toEqual(
          original.bytes,
        );
        expect(await attachments.resolveForPrompt([image.id])).toMatchObject({
          images: [{ data: original.bytes.toString("base64") }],
        });
      } finally {
        promptGate.resolve();
        await f.runtime.close();
      }
    },
  );
});
