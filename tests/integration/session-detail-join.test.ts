// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { AppStore } from "../../src/store";
import {
  closeHostApiFixture,
  hostApiFixture,
  observeEventSocket,
  token,
} from "../server/fixtures/host-api";
import { deferred, FakeWebSocket, installFakeWebSocket } from "../web/helpers";

let fixture: Awaited<ReturnType<typeof hostApiFixture>> | undefined;
afterEach(async () => {
  if (fixture) await closeHostApiFixture(fixture);
});

it("changes the addressed view through the Host without mixing old detail and queued events", async () => {
  installFakeWebSocket();
  const { baseUrl, runtime } = (fixture = await hostApiFixture());
  const previous = "fixture-active";
  const next = "fixture-history";
  await runtime.openSession(previous);
  const http = fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return http(new URL(String(input), baseUrl), { ...init, headers });
  });
  const store = new AppStore();
  await store.init();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  const { socket: hostSocket, frames } = observeEventSocket(
    `${baseUrl.replace("http", "ws")}/events?detail=${previous}`,
  );
  const release = deferred<void>();
  const read = deferred<void>();
  const originalSnapshot = runtime.snapshot.bind(runtime);
  try {
    await vi.waitFor(() => expect(frames[0]?.type).toBe("snapshot"));
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
    await store.openSession(next);
    const messages = store.getState().messages;
    expect(messages.length).toBeGreaterThan(0);

    vi.spyOn(runtime, "snapshot").mockImplementation(async (id) => {
      if (id === next) {
        read.resolve();
        await release.promise;
      }
      return originalSnapshot(id);
    });
    const interest = socket.sent.at(-1)!;
    expect(JSON.parse(interest)).toEqual({
      type: "detail_interest",
      sessionId: next,
      revision: 1,
    });
    hostSocket.send(interest);
    await read.promise;
    runtime.emit("event", {
      type: "agent_start",
      sessionId: next,
      sessionStatus: { runState: "running" },
    });
    expect(frames).toEqual([]);
    release.resolve();
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames.map(({ type }) => type)).toEqual(["snapshot", "agent_start"]);

    socket.emit(oldSnapshot);
    socket.emit(oldMessage!);
    expect(store.getState().sessionId).toBe(next);
    expect(store.getState().messages).toEqual(messages);

    socket.emit(frames[0]);
    socket.emit(frames[1]!);
    expect(store.getState()).toMatchObject({
      sessionId: next,
      connection: "open",
      sessionStatuses: { [next]: { runState: "running" } },
    });
    expect(store.getState().messages).toEqual(messages);
  } finally {
    release.resolve();
    hostSocket.close();
  }
}, 15_000);
