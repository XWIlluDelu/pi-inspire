import {
  bootstrapPayload,
  DEFAULT_PREFS,
  emptySnapshot,
  jsonBody,
  type RouteHandler,
  type RouteResponse,
  sessionSummary,
} from "../helpers";
import { initStore, installStoreRoutes, sessionPage } from "../store-fixture";

export { sessionPage };

export interface PageRequest {
  query: string;
  offset: number;
  limit: number;
  signal: RequestInit["signal"];
}

export const catalogRows = (ids: readonly string[]) =>
  ids.map((id) => sessionSummary({ id }));
export const pageResult = (
  ids: readonly string[],
  total = ids.length,
  offset = 0,
  limit = 40,
) => ({ body: sessionPage(catalogRows(ids), total, offset, limit) });
export const pageOf = (
  ids: readonly string[],
  { offset, limit }: Pick<PageRequest, "offset" | "limit">,
) => pageResult(ids.slice(offset, offset + limit), ids.length, offset, limit);

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
  installStoreRoutes(async (url, init) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          preferences: { ...DEFAULT_PREFS, ...preferences },
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
    return (
      (await routes?.(url, init)) ??
      (url === "/api/preferences" ? { body: jsonBody(init) } : undefined)
    );
  });
  return initStore(emptySnapshot);
}
