// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  closeHostApiFixture,
  hostApiFixture,
  observeEventSocket,
} from "../server/fixtures/host-api";
import {
  deferred,
  installFakeWebSocket,
  TEST_HOST_AUTHORITY,
} from "../web/helpers";
import { initStore, installStoreRoutes } from "../web/store-fixture";
import { forwardHostRequests } from "./host-requests";

let fixture: Awaited<ReturnType<typeof hostApiFixture>> | undefined;
afterEach(async () => {
  if (fixture) await closeHostApiFixture(fixture);
});

it("confirms a large unchanged window before new events despite already-sent detail from another session", async () => {
  installFakeWebSocket();
  const { application, baseUrl, runtime } = (fixture = await hostApiFixture());
  const forward = forwardHostRequests(application);
  const previous = "fixture-active";
  const next = "fixture-history";
  await runtime.openSession(previous);
  await runtime.openSession(next);
  await vi.waitFor(async () => {
    for (const id of [previous, next])
      expect(
        (await runtime.snapshot(id)).active?.runtimeSettings,
      ).toBeDefined();
  });
  const window = await runtime.snapshot(next);
  const message = {
    role: "user",
    content: "large window ".repeat(40_000),
    timestamp: 1,
  };
  window.active!.transcriptPage.messages = [message];
  const { socket: hostSocket, frames } = observeEventSocket(
    `${baseUrl.replace("http", "ws")}/events?detail=${previous}`,
  );
  const readStarted = deferred<void>();
  const releaseRead = deferred<void>();
  try {
    await vi.waitFor(() => expect(frames[0]?.type).toBe("snapshot"));
    runtime.emit("event", {
      type: "message_update",
      sessionId: previous,
      message: { role: "assistant", timestamp: 2, content: "Old detail" },
    });
    const oldFrame = await vi.waitFor(() => {
      const frame = frames.find(({ type }) => type === "message_update");
      expect(frame).toBeDefined();
      return frame!;
    });
    frames.length = 0;

    vi.spyOn(runtime, "openSession").mockResolvedValue(window);
    const snapshot = vi
      .spyOn(runtime, "snapshot")
      .mockResolvedValue(window)
      .mockImplementationOnce(async () => {
        readStarted.resolve();
        await releaseRead.promise;
        return window;
      });
    installStoreRoutes(async (url, init) => {
      if (url !== "/api/sessions/open") return;
      const response = await forward(url, init);
      expect(response.status).toBe(200);
      expect(Buffer.byteLength(JSON.stringify(response.body))).toBeGreaterThan(
        500_000,
      );
      return response;
    });
    const { store, socket } = await initStore();
    await store.openSession(next);
    const interest = JSON.parse(socket.sent.at(-1)!);
    expect(interest).toMatchObject({
      type: "detail_interest",
      sessionId: next,
    });
    const messages = store.getState().messages;
    expect(messages).toMatchObject([message]);
    const send = (patch: Record<string, unknown> = {}) =>
      hostSocket.send(
        JSON.stringify({
          ...interest,
          authorityId: application.authorityId,
          ...patch,
        }),
      );
    const incoming = () =>
      frames.filter(
        (frame) =>
          frame.detailRevision === interest.revision ||
          (frame.sessionId === next && frame.type === "agent_start"),
      );
    send();
    await readStarted.promise;
    runtime.emit("event", {
      type: "agent_start",
      sessionId: next,
      sessionStatus: { runState: "running" },
    });
    expect(incoming()).toEqual([]);
    releaseRead.resolve();
    await vi.waitFor(() => expect(incoming()).toHaveLength(2));
    const [confirmation, event] = incoming();
    expect(confirmation).toMatchObject({
      unchanged: true,
      detailRevision: interest.revision,
      snapshotDigest: interest.snapshotDigest,
    });
    expect(confirmation).not.toHaveProperty("data");
    expect(event?.type).toBe("agent_start");
    expect(Buffer.byteLength(JSON.stringify(incoming()))).toBeLessThan(2_000);

    socket.emit(oldFrame);
    socket.emit({ ...confirmation, authorityId: TEST_HOST_AUTHORITY });
    socket.emit(event!);
    expect(store.getState()).toMatchObject({
      sessionId: next,
      connection: "open",
      runState: "running",
    });
    expect(store.getState().messages).toEqual(messages);

    for (const [patch, value] of [
      [{}, { ...window, runState: "running" }],
      [{ authorityId: "00000000-0000-4000-8000-000000000000" }, window],
      [{ snapshotDigest: "0".repeat(64) }, window],
    ] as const) {
      const revision = ++interest.revision;
      snapshot.mockResolvedValueOnce(value);
      send(patch);
      await vi.waitFor(() =>
        expect(
          frames.find((frame) => frame.detailRevision === revision),
        ).toHaveProperty("data"),
      );
    }
  } finally {
    releaseRead.resolve();
    hostSocket.close();
  }
}, 15_000);
