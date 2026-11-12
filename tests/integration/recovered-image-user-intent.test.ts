// @vitest-environment jsdom
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInspireServer } from "../../server/app";
import { PreferencesStore } from "../../server/preferences";
import { ResourceStore } from "../../server/resources";
import { deleteSessionDraft } from "../../src/session-drafts";
import { token } from "../server/fixtures/host-api";
import {
  catalog,
  disposeRuntimeFixture,
  fixtureWorkspace,
  initializeRuntimeFixture,
  record,
  schedulingRuntime,
  trackedAttachmentStore,
  upload,
  waitForReady,
} from "../server/fixtures/runtime";
import {
  bootstrapPayload,
  deferred,
  installFakeWebSocket,
  jsonBody,
  type RouteResponse,
} from "../web/helpers";
import { initStore, installStoreRoutes } from "../web/store-fixture";
import { forwardHostRequests } from "./host-requests";

beforeEach(async () => {
  await initializeRuntimeFixture();
  installFakeWebSocket();
  deleteSessionDraft("a");
});
afterEach(disposeRuntimeFixture);

describe("Host-deferred image recovery", () => {
  it.each([
    { action: "keep", observer: "sender", first: "prompt" },
    { action: "keep", observer: "other browser", first: "return" },
    { action: "remove", observer: "sender", first: "return" },
    { action: "send", observer: "sender", first: "return" },
    { action: "queue-again", observer: "sender", first: "return" },
  ] as const)(
    "preserves $action by the $observer when $first settles first",
    async ({ action, observer, first }) => {
      const attachments = trackedAttachmentStore();
      const source = catalog([record("a", fixtureWorkspace)]);
      const { runtime, workers } = schedulingRuntime({ source, attachments });
      const gate = deferred<void>();
      const sent: Record<string, unknown>[] = [];
      let sending: Promise<unknown> | undefined;
      let promptResponse: RouteResponse | undefined;
      const application = createInspireServer({
        token,
        runtime,
        attachments,
        catalog: source,
        preferences: new PreferencesStore(join(fixtureWorkspace, "prefs.json")),
        resources: new ResourceStore(),
        git: {
          status: async () => ({ kind: "not-repository" }),
          diff: async () => {
            throw new Error("unused");
          },
        },
        version: "test",
        piVersion: "1.3.0",
      });
      const forward = forwardHostRequests(application);
      const waitForQueuedInput = () =>
        vi.waitFor(async () =>
          expect((await runtime.snapshot()).pendingQueues?.totalCount).toBe(1),
        );
      try {
        await runtime.openSession("a");
        await waitForReady(runtime);
        const worker = workers[0]!;
        const image = await attachments.add(upload("intent.png", "image/png"));
        const original = await attachments.imagePreview(image.id);
        let isCompacting = true;
        worker.responseOverrides.set("get_state", () => ({
          sessionId: "a",
          isCompacting,
          isStreaming: false,
        }));
        worker.emit("event", { type: "compaction_start", reason: "auto" });
        installStoreRoutes(async (url, init) => {
          if (url.startsWith("/api/bootstrap"))
            return {
              body: bootstrapPayload({
                snapshot: {
                  ...(await runtime.snapshot()),
                  runState: "compacting",
                },
              }),
            };
          if (url === "/api/attachments")
            return { body: { attachments: [image] } };
          if (url.endsWith("/image"))
            return {
              status: 502,
              body: { error: "Preview temporarily unavailable" },
            };
          if (
            url === "/api/prompt" ||
            url === "/api/pending/recover" ||
            url.startsWith("/api/attachments/")
          ) {
            if (url === "/api/prompt") sent.push(jsonBody(init));
            const index = sent.length;
            const response = await forward(url, init);
            if (url === "/api/prompt" && index === 1) {
              promptResponse = response;
              if (first === "return") await gate.promise;
            }
            if (url === "/api/pending/recover" && first === "prompt")
              await sending;
            return response;
          }
        });
        const { store: sender } = await initStore();
        const store =
          observer === "sender" ? sender : (await initStore()).store;
        await sender.addFiles([
          new File(["pixels"], "intent.png", { type: "image/png" }),
        ]);
        sending = sender.sendPrompt(
          first === "prompt" ? "original caption" : "",
          "followUp",
        );
        await waitForQueuedInput();
        expect(await store.recoverPending()).toBe(true);
        await vi.waitFor(() =>
          expect(store.getState().attachments[0]?.previewLoading).toBe(false),
        );
        expect(store.getState().attachments[0]).toMatchObject({
          uploadedId: image.id,
          status: "ready",
        });
        const finishOriginalPrompt = async () => {
          gate.resolve();
          expect(await sending).toBe(false);
          expect(promptResponse).toMatchObject({
            status: 409,
            body: {
              code: "PROMPT_RECOVERED",
              recoveredAttachments: [image],
              recoveryId: expect.any(String),
            },
          });
        };
        if (action === "keep") {
          await finishOriginalPrompt();
          for (const observerStore of new Set([sender, store])) {
            expect(
              observerStore
                .getState()
                .attachments.map(({ uploadedId }) => uploadedId),
            ).toEqual([image.id]);
          }
          expect((await runtime.snapshot()).pendingQueues?.totalCount).toBe(0);
          expect(await attachments.resolveForPrompt([image.id])).toMatchObject({
            images: [{ data: original.bytes.toString("base64") }],
          });
          return;
        }
        const finishCompaction = async () => {
          isCompacting = false;
          worker.emit("event", {
            type: "compaction_end",
            reason: "auto",
            aborted: true,
          });
          await vi.waitFor(async () =>
            expect((await runtime.snapshot()).runState).toBe("aborted"),
          );
        };
        if (action === "send") {
          await finishCompaction();
          expect(
            await store.sendPrompt("use the returned image"),
          ).toMatchObject({ accepted: true });
          expect(sent.at(-1)?.attachmentIds).toEqual([image.id]);
        } else if (action === "queue-again") {
          const next = store.sendPrompt(
            "queue the same image again",
            "followUp",
          );
          await waitForQueuedInput();
          expect(await store.recoverPending()).toBe(true);
          expect(await next).toBe(false);
          expect(
            store.getState().attachments.map((item) => item.uploadedId),
          ).toEqual([image.id]);
        }
        if (action !== "send") {
          store.removeAttachment(store.getState().attachments[0]!.localId);
        }
        await vi.waitFor(() =>
          expect(store.getState().attachments).toEqual([]),
        );
        await vi.waitFor(async () =>
          expect(attachments.imagePreview(image.id)).rejects.toMatchObject({
            status: 404,
          }),
        );
        await finishOriginalPrompt();
        expect(store.getState().attachments).toEqual([]);
        if (action !== "send") await finishCompaction();
        expect(await store.sendPrompt("plain text afterwards")).toMatchObject({
          accepted: true,
        });
        expect(sent.at(-1)).not.toHaveProperty("attachmentIds");
      } finally {
        gate.resolve();
        await runtime.close();
        await sending;
        await application.close();
      }
    },
  );
});
