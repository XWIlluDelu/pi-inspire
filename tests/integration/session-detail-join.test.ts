// @vitest-environment jsdom
import { appendFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { AppStore } from "../../src/store";
import {
  closeHostApiFixture,
  hostApiFixture,
  observeEventSocket,
  token,
} from "../server/fixtures/host-api";
import { jsonl, messageEntry } from "../server/fixtures/session-jsonl";
import { deferred, FakeWebSocket, installFakeWebSocket } from "../web/helpers";

let fixture: Awaited<ReturnType<typeof hostApiFixture>> | undefined;
afterEach(async () => {
  if (fixture) await closeHostApiFixture(fixture);
});

it("changes the addressed view and resumes it through the Host across an atomic snapshot cut", async () => {
  installFakeWebSocket();
  const { baseUrl, runtime, localRequest } = (fixture = await hostApiFixture());
  const previous = "fixture-active";
  const next = "fixture-history";
  await runtime.openSession(previous);
  const http = fetch;
  const request = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return http(new URL(String(input), baseUrl), { ...init, headers });
  });
  vi.stubGlobal("fetch", request);
  const originalSnapshot = runtime.snapshot.bind(runtime);
  const observed = vi.spyOn(runtime, "snapshot");
  const bootstrap = (await localRequest.get("/api/bootstrap").expect(200)).body;
  expect(bootstrap).toMatchObject({
    startupSessionId: previous,
    authorityId: fixture.application.authorityId,
  });
  expect(bootstrap).not.toHaveProperty("snapshot");
  expect(observed).not.toHaveBeenCalled();
  const store = new AppStore();
  await store.init();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  const connect = (peer: FakeWebSocket) => {
    const url = new URL(peer.url);
    return observeEventSocket(
      `${baseUrl.replace("http", "ws")}${url.pathname}?detail=${encodeURIComponent(url.searchParams.get("detail") ?? "")}`,
    );
  };
  const { socket: hostSocket, frames } = connect(socket);
  let resumed: ReturnType<typeof connect> | undefined;
  const release = deferred<void>();
  const read = deferred<void>();
  const capture = deferred<void>();
  const open = deferred<void>();
  try {
    await vi.waitFor(() => expect(frames[0]?.type).toBe("snapshot"));
    expect(frames[0]).toMatchObject({
      detailSessionId: previous,
      detailRevision: 0,
      authorityId: bootstrap.authorityId,
    });
    socket.emit(frames[0]);
    expect(store.getState()).toMatchObject({
      sessionId: previous,
      connection: "open",
    });
    runtime.emit("event", {
      type: "message_update",
      sessionId: previous,
      message: { role: "assistant", content: "Old detail", timestamp: 2 },
    });
    await vi.waitFor(() => expect(frames[1]?.type).toBe("message_update"));
    const [oldSnapshot, oldMessage] = frames.splice(0);
    const actualOpen = runtime.openSession.bind(runtime);
    vi.spyOn(runtime, "openSession").mockImplementation(async (id) => {
      expect(id).toBe(next);
      await open.promise;
      return actualOpen(id);
    });
    const opening = store.openSession(next);
    await vi.waitFor(() =>
      expect(runtime.openSession).toHaveBeenCalledWith(next),
    );
    runtime.emit("event", {
      type: "runtime_ready",
      sessionId: next,
      sessionStatus: { runState: "idle" },
    });
    await vi.waitFor(() => expect(frames[0]?.type).toBe("runtime_ready"));
    socket.emit(frames.shift()!);
    open.resolve();
    await opening;
    const messages = store.getState().live.messages;
    expect(messages.length).toBeGreaterThan(0);
    const view = (await originalSnapshot(next)).active!;
    let tip = view.durableLeafId!;
    const write = async (id: string) => {
      await appendFile(
        view.sessionFile!,
        jsonl(
          messageEntry(id, tip, { role: "user", content: id, timestamp: 3 }),
        ),
      );
      tip = id;
      return originalSnapshot(next);
    };

    observed.mockImplementation(async (id) => {
      if (id !== next) return originalSnapshot(id);
      await capture.promise;
      const snapshot = await originalSnapshot(id);
      read.resolve();
      await release.promise;
      return snapshot;
    });
    const interest = socket.sent.at(-1)!;
    expect(JSON.parse(interest)).toEqual({
      type: "detail_interest",
      sessionId: next,
      revision: 1,
    });
    observed.mockClear();
    hostSocket.send(interest);
    await vi.waitFor(() => expect(observed).toHaveBeenCalledWith(next));
    await write("included-before-cut");
    capture.resolve();
    await vi.waitFor(() => read.promise, { timeout: 2_000 });
    await write("queued-after-cut");
    runtime.emit("event", {
      type: "agent_start",
      sessionId: next,
      sessionStatus: { runState: "running" },
    });
    expect(frames).toEqual([]);
    release.resolve();
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(frames.map(({ type }) => type)).toEqual([
      "snapshot",
      "session_projection_changed",
      "agent_start",
    ]);
    expect(frames[0]?.data?.active).toMatchObject({
      durableLeafId: "included-before-cut",
      effectiveLeafId: "included-before-cut",
    });
    expect(frames[1]?.transcript).toMatchObject({
      durableLeafId: "queued-after-cut",
      effectiveLeafId: "queued-after-cut",
      projectionHealth: { status: "ok" },
      transcriptPage: { viewId: view.transcriptPage.viewId },
    });

    socket.emit(oldSnapshot);
    socket.emit(oldMessage!);
    expect(store.getState().sessionId).toBe(next);
    expect(store.getState().live.messages).toEqual(messages);

    for (const frame of frames) socket.emit(frame);
    expect(
      request.mock.calls.some(([url]) =>
        String(url).startsWith("/api/snapshot"),
      ),
    ).toBe(false);
    expect(store.getState()).toMatchObject({
      sessionId: next,
      connection: "open",
      sessionStatuses: { [next]: { runState: "running" } },
    });
    const current = store.getState().live.messages;
    expect(current.slice(-2).map(({ content }) => content)).toEqual([
      "included-before-cut",
      "queued-after-cut",
    ]);
    expect(current.slice(0, -2)).toEqual(messages);

    socket.close();
    hostSocket.close();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), {
      timeout: 2_000,
    });
    const replacement = FakeWebSocket.instances[1]!;
    expect(new URL(replacement.url).searchParams.get("detail")).toBe(next);
    replacement.open();
    resumed = connect(replacement);
    const reconnect = resumed;
    await vi.waitFor(() => expect(reconnect.frames[0]?.type).toBe("snapshot"));
    socket.emit(oldMessage!);
    replacement.emit(reconnect.frames[0]);
    expect(store.getState()).toMatchObject({
      sessionId: next,
      connection: "open",
      live: { messages: current },
    });
  } finally {
    open.resolve();
    capture.resolve();
    release.resolve();
    hostSocket.close();
    resumed?.socket.close();
  }
}, 15_000);
