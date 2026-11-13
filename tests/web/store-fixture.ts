import type { SessionSummary } from "../../shared/contracts";
import { AppStore } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFetch,
  type RouteHandler,
} from "./helpers";

export function sessionPage(
  sessions: SessionSummary[],
  total: number,
  offset = 0,
  limit = 40,
) {
  return { sessions, total, offset, limit };
}

export const baseRoutes: RouteHandler = (url) => {
  if (url.startsWith("/api/bootstrap"))
    return { body: bootstrapPayload({ startupSessionId: "s1" }) };
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

export async function initStore(snapshot = activeSnapshot()): Promise<{
  store: AppStore;
  socket: FakeWebSocket;
}> {
  const store = new AppStore();
  await store.init();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.join(snapshot);
  return { store, socket };
}
