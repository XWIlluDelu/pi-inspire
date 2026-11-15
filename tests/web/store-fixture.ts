import type { SessionSummary } from "../../shared/contracts";
import { AppStore } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  inputReceipt,
  installFetch,
  jsonBody,
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

export const baseRoutes: RouteHandler = (url, init) => {
  if (url.startsWith("/api/bootstrap"))
    return { body: bootstrapPayload({ startupSessionId: "s1" }) };
  if (url.startsWith("/api/snapshot")) return { body: activeSnapshot() };
  if (url === "/api/pending/recover" || url === "/api/control/abort")
    return {
      body: {
        ...inputReceipt(
          url === "/api/control/abort" ? "abort" : "recover",
          jsonBody(init),
        ),
        state: "completed",
        result: { steering: [], followUp: [] },
      },
    };
  if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
  return undefined;
};

export function installStoreRoutes(route: RouteHandler) {
  return installFetch(
    async (url, init) => (await route(url, init)) ?? baseRoutes(url, init),
  );
}

export async function initStore(
  snapshot = activeSnapshot(),
  authorityId?: string,
): Promise<{
  store: AppStore;
  socket: FakeWebSocket;
}> {
  const store = new AppStore();
  await store.init();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.join(snapshot, authorityId ? { authorityId } : undefined);
  return { store, socket };
}
