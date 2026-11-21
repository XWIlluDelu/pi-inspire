import {
  bootstrapPayload,
  DEFAULT_PREFS,
  emptySnapshot,
  jsonBody,
  type RouteHandler,
  type RouteResponse,
} from "../helpers";
import { initStore, installStoreRoutes, sessionPage } from "../store-fixture";

export { sessionPage };

interface PageRequest {
  query: string;
  offset: number;
  limit: number;
  signal: RequestInit["signal"];
}

export function installCatalog(
  list: (page: PageRequest) => RouteResponse | Promise<RouteResponse>,
  {
    preferences,
    routes,
  }: {
    preferences?: Partial<typeof DEFAULT_PREFS>;
    routes?: RouteHandler;
  } = {},
) {
  let confirmed = { ...DEFAULT_PREFS, ...preferences };
  let revision = 0;
  installStoreRoutes(async (url, init) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          preferences: confirmed,
          preferenceRevision: revision,
        }),
      };
    if (url.startsWith("/api/sessions?")) {
      const params = new URL(url, "http://local").searchParams;
      return list({
        query: params.get("q") ?? "",
        offset: Number(params.get("offset") ?? 0),
        limit: Number(params.get("limit") ?? 40),
        signal: init.signal,
      });
    }
    const route = await routes?.(url, init);
    if (route) return route;
    if (url === "/api/preferences" && init.method === "PATCH") {
      confirmed = { ...confirmed, ...jsonBody(init) };
      revision++;
    }
    if (url === "/api/preferences")
      return { body: { preferences: confirmed, revision } };
  });
  return initStore(emptySnapshot);
}
