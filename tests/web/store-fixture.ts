import type { ActiveSnapshot } from "../../shared/contracts";
import { AppStore } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFetch,
  type RouteHandler,
} from "./helpers";

export const baseRoutes: RouteHandler = (url) => {
  if (url.startsWith("/api/bootstrap"))
    return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
  if (url.startsWith("/api/snapshot")) return { body: activeSnapshot() };
  if (url === "/api/pending/recover" || url === "/api/control/abort")
    return { body: { steering: [], followUp: [] } };
  if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
  return undefined;
};

export function installStoreRoutes(route: RouteHandler) {
  return installFetch(
    async (url, init) => (await route(url, init)) ?? baseRoutes(url, init),
  );
}

export function installStoreSnapshot(
  snapshot: ActiveSnapshot,
  route: RouteHandler,
) {
  return installStoreRoutes((url, init) => {
    if (url.startsWith("/api/bootstrap"))
      return { body: bootstrapPayload({ snapshot }) };
    return route(url, init);
  });
}

export async function initStore(): Promise<{
  store: AppStore;
  socket: FakeWebSocket;
}> {
  const store = new AppStore();
  await store.init();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open(FakeWebSocket.bootstrapSnapshot ?? activeSnapshot());
  return { store, socket };
}
