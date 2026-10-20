// @vitest-environment jsdom
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInspireServer } from "../../server/app";
import { PreferencesStore } from "../../server/preferences";
import { ResourceStore } from "../../server/resources";
import { deleteSessionDraft } from "../../src/session-drafts";
import {
  catalog,
  disposeRuntimeFixture,
  initializeRuntimeFixture,
  record,
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

describe("recovered images retain later user intent", () => {
  it.each(["remove", "send", "queue-again"] as const)(
    "does not undo %s when the original prompt response arrives late",
    async (action) => {
      const root = await mkdtemp(join(tmpdir(), "inspire-image-intent-"));
      const attachments = trackedAttachmentStore();
      const session = record("a", root);
      const f = schedulingRuntime({ sessions: [session], attachments });
      const gate = deferred<void>();
      const sent: Record<string, unknown>[] = [];
      let sending: Promise<unknown> | undefined;
      const application = createInspireServer({
        token: "synthetic-image-intent",
        runtime: f.runtime,
        attachments,
        catalog: catalog([session]),
        preferences: new PreferencesStore(join(root, "prefs.json")),
        resources: new ResourceStore(),
        git: {
          status: async () => ({ kind: "not-repository" }),
          diff: async () => {
            throw new Error("unused");
          },
        },
        mock: true,
        version: "test",
        piVersion: "1.3.0",
      });
      try {
        await f.runtime.openSession("a");
        await waitForReady(f.runtime);
        const image = await attachments.add(upload("intent.png", "image/png"));
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
            const body = jsonBody(init);
            if (url === "/api/prompt") sent.push(body);
            const index = sent.length;
            const req = request(application.server);
            const response =
              init.method === "DELETE"
                ? await req
                    .delete(url)
                    .set("Authorization", "Bearer synthetic-image-intent")
                : await req
                    .post(url)
                    .set("Authorization", "Bearer synthetic-image-intent")
                    .send({ ...body, authorityId: application.authorityId });
            if (url === "/api/prompt" && index === 1) await gate.promise;
            return {
              status: response.status,
              body: {
                ...response.body,
                ...(response.body.authorityId
                  ? { authorityId: TEST_HOST_AUTHORITY }
                  : {}),
              },
              headers: {
                ...response.headers,
                "x-inspire-authority": TEST_HOST_AUTHORITY,
              },
            };
          }
          return baseRoutes(url, init);
        });
        const { store } = await initStore();
        await store.addFiles([
          new File(["pixels"], "intent.png", { type: "image/png" }),
        ]);
        sending = store.sendPrompt("", "followUp");
        await vi.waitFor(async () =>
          expect((await f.runtime.snapshot()).pendingQueues?.totalCount).toBe(
            1,
          ),
        );
        expect(await store.recoverPending()).toBe(true);
        await vi.waitFor(() =>
          expect(store.getState().attachments[0]?.previewLoading).toBe(false),
        );
        expect(store.getState().attachments[0]).toMatchObject({
          uploadedId: image.id,
          status: "ready",
        });
        if (action === "send") {
          f.worker.responseOverrides.set("get_state", () => ({
            sessionId: "a",
            isCompacting: false,
            isStreaming: false,
          }));
          f.worker.emit("event", {
            type: "compaction_end",
            reason: "auto",
            aborted: true,
          });
          await vi.waitFor(async () =>
            expect((await f.runtime.snapshot()).runState).toBe("aborted"),
          );
          expect(
            await store.sendPrompt("use the returned image"),
          ).toMatchObject({ accepted: true });
          expect(sent.at(-1)?.attachmentIds).toEqual([image.id]);
        } else if (action === "queue-again") {
          const next = store.sendPrompt(
            "queue the same image again",
            "followUp",
          );
          await vi.waitFor(async () =>
            expect((await f.runtime.snapshot()).pendingQueues?.totalCount).toBe(
              1,
            ),
          );
          expect(await store.recoverPending()).toBe(true);
          expect(await next).toBe(false);
          expect(
            store.getState().attachments.map((item) => item.uploadedId),
          ).toEqual([image.id]);
          store.removeAttachment(store.getState().attachments[0]!.localId);
        } else {
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
        gate.resolve();
        expect(await sending).toBe(false);
        expect(store.getState().attachments).toEqual([]);
        f.worker.responseOverrides.set("get_state", () => ({
          sessionId: "a",
          isCompacting: false,
          isStreaming: false,
        }));
        f.worker.emit("event", {
          type: "compaction_end",
          reason: "auto",
          aborted: true,
        });
        await vi.waitFor(async () =>
          expect((await f.runtime.snapshot()).runState).not.toBe("compacting"),
        );
        expect(await store.sendPrompt("plain text afterwards")).toMatchObject({
          accepted: true,
        });
        expect(sent.at(-1)).not.toHaveProperty("attachmentIds");
      } finally {
        gate.resolve();
        await f.runtime.close();
        await sending;
        await application.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
