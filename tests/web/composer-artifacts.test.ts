// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { UploadedAttachment } from "../../shared/contracts";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  jsonBody,
  type RouteResponse,
  selectSession,
  TEST_HOST_AUTHORITY,
} from "./helpers";
import { pendingQueues } from "./pending-fixtures";
import { initStore, installStoreRoutes } from "./store-fixture";

beforeEach(() => installFakeWebSocket());

it("merges delayed recovery into the original draft and retains material above the send limit", async () => {
  const recovery = deferred<RouteResponse>();
  const handles = Array.from({ length: 8 }, (_, index) => `image-${index}`);
  const images = handles.map<UploadedAttachment>((id) => ({
    id,
    fileName: `${id}.png`,
    mimeType: "image/png",
    kind: "image",
    size: 7,
  }));
  const requests = installStoreRoutes((url, init) => {
    if (url === "/api/pending/recover") return recovery.promise;
    if (url === "/api/attachments")
      return {
        body: {
          attachments: [
            { id: "saved-file", fileName: "latest.txt", kind: "file" },
          ],
        },
      };
    if (url.endsWith("/image")) return { body: "preview bytes" };
    if (init.method === "DELETE") return { body: { ok: true } };
  });
  const { store } = await initStore();
  const draft = (id = "s1") => store.drafts.get(id);
  await store.addFiles([new File(["draft file"], "latest.txt")]);
  store.addProjectFile("README.md");
  store.drafts.setText("s1", "first draft");
  const restoring = store.recoverPending();
  store.drafts.setText("s1", "newest draft");
  await selectSession(store, activeSnapshot({ sessionId: "s2" }));
  store.drafts.setText("s2", "other session");
  recovery.resolve({
    body: {
      steering: ["queued caption"],
      followUp: ["next input"],
      attachments: images,
      authorityId: TEST_HOST_AUTHORITY,
    },
  });
  expect(await restoring).toBe(true);
  expect(draft("s2")).toMatchObject({ text: "other session", attachments: [] });
  const text = "queued caption\n\nnext input\n\nnewest draft";
  expect(draft()).toMatchObject({ text, projectFiles: ["README.md"] });
  await selectSession(store, activeSnapshot());
  expect(await store.sendPrompt(text)).toBe(false);
  expect(store.getState().live.notices.at(-1)?.text).toBe(
    "At most 8 attachments per message",
  );
  const staged = () => draft().attachments.map((item) => item.uploadedId);
  expect(staged()).toEqual([...handles, "saved-file"]);
  await vi.waitFor(() =>
    expect(draft().attachments[0]?.previewUrl).toMatch(/^blob:/),
  );
  store.removeAttachment(draft().attachments[0]!.localId);
  expect(staged()).toEqual([...handles.slice(1), "saved-file"]);
  expect(requests).toHaveBeenCalledWith(
    `/api/attachments/${handles[0]}`,
    expect.objectContaining({ method: "DELETE" }),
  );
});

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
      prompt(jsonBody(init));
      return { status: 202, body: { accepted: true } };
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
  await store.sendPrompt("send");
  expect(prompt).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ authorityId, attachmentIds: ["upload-2"] }),
  );
});
