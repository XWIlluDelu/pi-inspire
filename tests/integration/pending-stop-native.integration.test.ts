// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { BootstrapResponse } from "../../shared/contracts";
import { AppStore } from "../../src/store";
import {
  disposeOperationFixture,
  fixture,
} from "../server/fixtures/native-operation";
import { deferred, FakeWebSocket, installFakeWebSocket } from "../web/helpers";

it("stops a second native Pi run after both HTTP observations of the first Stop were lost", async () => {
  const browserWindow = window;
  const gate = deferred<void>();
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let store: AppStore | undefined;
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  try {
    f = await fixture(false, 35_000, gate.promise);
    vi.stubGlobal("window", browserWindow);
    installFakeWebSocket();
    const bridge = fetch;
    let bootstrap!: BootstrapResponse;
    let losePost = true,
      loseGet = true;
    const ids: string[] = [];
    vi.stubGlobal("fetch", (async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", "Bearer pi-operation-synthetic-local-token");
      const response = await bridge(input, { ...init, headers });
      const url = String(input);
      if (url.startsWith("/api/bootstrap"))
        bootstrap = await response.clone().json();
      if (url === "/api/control/abort") {
        ids.push(JSON.parse(String(init?.body)).operationId);
        if (losePost) {
          losePost = false;
          throw new TypeError("lost Stop response");
        }
      }
      if (url.startsWith("/api/pending/operations/") && loseGet) {
        loseGet = false;
        throw new TypeError("lost Stop receipt");
      }
      return response;
    }) satisfies typeof fetch);
    store = new AppStore();
    await store.init("pi-operation-synthetic-local-token");
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.readyState = 1;
    socket.onopen?.({});
    socket.emit({
      type: "snapshot",
      authorityId: bootstrap.authorityId,
      snapshotDigest: bootstrap.snapshotDigest,
      data: bootstrap.snapshot,
    });
    listener = (event) => socket.emit(event);
    f.runtime.on("event", listener);
    await f.api.prompt(f.delivery("First isolated run"));
    await vi.waitFor(() => expect(f!.modelRequests).toHaveLength(1));
    await store.abort();
    await vi.waitFor(() => expect(store!.getState().runState).toBe("aborted"));
    await f.api.prompt(f.delivery("Second isolated run"));
    await vi.waitFor(() => expect(f!.modelRequests).toHaveLength(2));
    expect(store.getState().runState).toBe("running");
    await store.abort();
    await vi.waitFor(async () =>
      expect((await f!.runtime.snapshot()).runState).toBe("aborted"),
    );
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
    expect(store.getState().connection).toBe("open");
    expect(
      f.piEvents.filter(
        (event) => event.type === "agent_settled" && event.aborted === true,
      ),
    ).toHaveLength(2);
  } finally {
    if (f && listener) f.runtime.off("event", listener);
    (
      store as unknown as { connectionController: { stop(): void } } | undefined
    )?.connectionController.stop();
    gate.resolve();
    await disposeOperationFixture();
  }
}, 30_000);
