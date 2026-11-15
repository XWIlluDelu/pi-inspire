// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  inputReceipt,
  installFakeWebSocket,
  jsonBody,
  type RouteResponse,
  selectSession,
  TEST_HOST_AUTHORITY,
} from "./helpers";
import { pendingQueues } from "./pending-fixtures";
import { initStore, installStoreRoutes } from "./store-fixture";

beforeEach(() => installFakeWebSocket());

it("copies addressed Pending bytes without mutations and retires queued reads after navigation or replacement", async () => {
  const delayedText = deferred<RouteResponse>();
  const delayedImage = deferred<RouteResponse>();
  const outcome = {
    text: "",
    images: [
      { data: btoa("saved pixels"), mimeType: "image/png" },
      { attachmentId: "queued" },
    ],
  };
  const readText = vi
    .fn<
      (
        address: Record<string, unknown>,
      ) => RouteResponse | Promise<RouteResponse>
    >()
    .mockReturnValue({ body: outcome });
  const readImage = vi
    .fn()
    .mockReturnValueOnce(
      new Response("uploaded pixels", {
        headers: { "Content-Type": "image/png" },
      }),
    )
    .mockReturnValueOnce(delayedImage.promise);
  const requests = installStoreRoutes((url, init) => {
    if (url === "/api/pending/text") return readText(jsonBody(init));
    if (url === "/api/attachments/queued/image") return readImage();
  });
  const { store, socket } = await initStore();
  expect(await store.pendingText(7, "text-steer-0")).toMatchObject({
    text: "",
    images: [
      { type: "image/png", size: "saved pixels".length },
      { type: "image/png", size: "uploaded pixels".length },
    ],
  });
  expect(readText).toHaveBeenCalledExactlyOnceWith({
    sessionId: "s1",
    viewId: "view-s1",
    revision: 7,
    itemId: "text-steer-0",
  });

  const readingImage = store.pendingText(store.getState().live.queue.revision);
  await vi.waitFor(() => expect(readImage).toHaveBeenCalledTimes(2));
  socket.emitSnapshot({
    ...activeSnapshot(),
    pendingQueues: pendingQueues([], [], { revision: 99 }),
  });
  delayedImage.resolve({ body: "late pixels" });
  expect(await readingImage).toBeNull();

  readText.mockReturnValueOnce(delayedText.promise);
  const readingText = store.pendingText(99);
  await selectSession(store, activeSnapshot({ sessionId: "s2" }));
  delayedText.resolve({ body: { text: "old queue", images: [] } });
  expect(await readingText).toBeNull();

  const refusal = "Pending input changed; copy the current item again";
  readText.mockReturnValueOnce({ status: 409, body: { error: refusal } });
  expect(await store.pendingText(7)).toBeNull();
  expect(store.getState().live.notices.at(-1)?.text).toBe(refusal);
  const mutations = requests.mock.calls.filter(
    ([url, init]) =>
      url === "/api/pending/recover" ||
      url === "/api/pending/clear" ||
      init?.method === "DELETE",
  );
  expect(mutations).toEqual([]);
  expect(store.drafts.get("s2").attachments).toEqual([]);
});

it("reuploads browser-held attachments only after a different Host confirms its authority", async () => {
  let authorityId = TEST_HOST_AUTHORITY;
  let uploads = 0;
  const prompt = vi.fn();
  installStoreRoutes((url, init) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({ startupSessionId: "s1", authorityId }),
      };
    if (url === "/api/attachments")
      return {
        body: {
          attachments: [
            { id: `upload-${++uploads}`, fileName: "notes.txt", kind: "file" },
          ],
        },
      };
    if (url === "/api/prompt") {
      const body = jsonBody(init);
      prompt(body);
      return {
        status: 202,
        body: {
          ...inputReceipt("prompt", body),
          state: "completed",
          result: null,
        },
      };
    }
  });
  const { store } = await initStore();
  const attachment = () => store.drafts.get("s1").attachments[0];
  await store.addFiles([new File(["notes"], "notes.txt")]);
  await store.init();
  expect(attachment()?.status).toBe("ready");
  expect(uploads).toBe(1);
  authorityId = "22222222-2222-4222-8222-222222222222";
  await store.init();
  expect(attachment()?.status).toBe("uploading");
  FakeWebSocket.instances.at(-1)!.join(activeSnapshot(), { authorityId });
  await vi.waitFor(() =>
    expect(attachment()).toMatchObject({
      status: "ready",
      uploadedId: "upload-2",
      uploadedAuthorityId: authorityId,
    }),
  );
  expect(prompt).not.toHaveBeenCalled();
  await expect(store.sendPrompt("send")).resolves.toMatchObject({
    accepted: true,
  });
  expect(prompt).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ authorityId, attachmentIds: ["upload-2"] }),
  );
});
