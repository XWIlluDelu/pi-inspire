// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHostApiFixture,
  hostApiFixture,
} from "../server/fixtures/host-api";
import {
  catalog,
  disposeRuntimeFixture,
  fixtureWorkspace,
  initializeRuntimeFixture,
  record,
  schedulingRuntime,
  startWorker,
  trackedAttachmentStore,
  upload,
} from "../server/fixtures/runtime";
import { deferred, installFakeWebSocket, jsonBody } from "../web/helpers";
import { initStore } from "../web/store-fixture";

beforeEach(async () => {
  await initializeRuntimeFixture();
  installFakeWebSocket();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await disposeRuntimeFixture();
});

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
      let promptResponse: Response | undefined;
      const host = await hostApiFixture({
        services: {
          runtime,
          catalog: source,
          attachments,
          cwd: fixtureWorkspace,
        },
      });
      const waitForQueuedInput = () =>
        vi.waitFor(async () =>
          expect((await runtime.snapshot("a")).pendingQueues?.totalCount).toBe(
            1,
          ),
        );
      try {
        await runtime.openSession("a");
        await startWorker(runtime);
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
        vi.stubGlobal("fetch", (async (input, init) => {
          const url = String(input);
          // Stage the fixture's real attachment and isolate preview failure from
          // the return and removal actions this journey exercises.
          if (url === "/api/attachments")
            return Response.json({ attachments: [image] });
          if (url.endsWith("/image"))
            return Response.json(
              { error: "Preview temporarily unavailable" },
              { status: 502 },
            );
          if (url === "/api/prompt") sent.push(jsonBody(init ?? {}));
          const index = sent.length;
          const response = await host.fetchHost(input, init);
          if (url === "/api/prompt" && index === 1) {
            promptResponse = response.clone();
            if (first === "return") await gate.promise;
          }
          if (url === "/api/pending/recover" && first === "prompt")
            await sending;
          return response;
        }) satisfies typeof fetch);
        const snapshot = await runtime.snapshot("a");
        const connect = () => initStore(snapshot, host.application.authorityId);
        const { store: sender } = await connect();
        const store = observer === "sender" ? sender : (await connect()).store;
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
          expect(
            store.drafts.get(store.getState().sessionId).attachments[0]
              ?.previewLoading,
          ).toBe(false),
        );
        expect(
          store.drafts.get(store.getState().sessionId).attachments[0],
        ).toMatchObject({
          uploadedId: image.id,
          status: "ready",
        });
        const finishOriginalPrompt = async () => {
          gate.resolve();
          expect(await sending).toBe(false);
          expect(promptResponse?.status).toBe(409);
          expect(await promptResponse?.json()).toMatchObject({
            state: "rejected",
            error: {
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
              observerStore.drafts
                .get("a")
                .attachments.map(({ uploadedId }) => uploadedId),
            ).toEqual([image.id]);
          }
          expect((await runtime.snapshot("a")).pendingQueues?.totalCount).toBe(
            0,
          );
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
            expect(
              (await runtime.snapshot("a")).sessionStatuses["a"]?.runState,
            ).toBe("aborted"),
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
            store.drafts
              .get(store.getState().sessionId)
              .attachments.map((item) => item.uploadedId),
          ).toEqual([image.id]);
        }
        if (action !== "send") {
          store.removeAttachment(
            store.drafts.get(store.getState().sessionId).attachments[0]!
              .localId,
          );
        }
        await vi.waitFor(() =>
          expect(
            store.drafts.get(store.getState().sessionId).attachments,
          ).toEqual([]),
        );
        await vi.waitFor(async () =>
          expect(attachments.imagePreview(image.id)).rejects.toMatchObject({
            status: 404,
          }),
        );
        await finishOriginalPrompt();
        expect(
          store.drafts.get(store.getState().sessionId).attachments,
        ).toEqual([]);
        if (action !== "send") await finishCompaction();
        expect(await store.sendPrompt("plain text afterwards")).toMatchObject({
          accepted: true,
        });
        expect(sent.at(-1)).not.toHaveProperty("attachmentIds");
      } finally {
        gate.resolve();
        await runtime.close();
        await sending;
        await closeHostApiFixture(host);
      }
    },
  );
});
