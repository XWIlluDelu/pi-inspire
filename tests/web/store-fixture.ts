import { AppStore } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  type RouteHandler,
} from "./helpers";

export const baseRoutes: RouteHandler = (url) => {
  if (url.startsWith("/api/bootstrap"))
    return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
  if (url.startsWith("/api/snapshot")) return { body: activeSnapshot() };
  if (url.startsWith("/api/sessions"))
    return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
  return undefined;
};

export function requestToken(init: RequestInit): string | null {
  const authorization = (init.headers as Record<string, string> | undefined)
    ?.Authorization;
  return authorization?.replace(/^Bearer /u, "") ?? null;
}

export async function initStore(): Promise<{
  store: AppStore;
  socket: FakeWebSocket;
}> {
  const store = new AppStore();
  await store.init("token");
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open(FakeWebSocket.bootstrapSnapshot ?? activeSnapshot());
  return { store, socket };
}
