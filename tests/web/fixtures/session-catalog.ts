import {
  bootstrapPayload,
  DEFAULT_PREFS,
  emptySnapshot,
  installFetch,
  type RouteHandler,
  type RouteResponse,
} from "../helpers";
import { initStore } from "../store-fixture";

export { sessionPage } from "../store-fixture";

export interface PageRequest {
  query: string;
  offset: number;
  limit: number;
  signal: AbortSignal | null | undefined;
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
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          preferences: { ...DEFAULT_PREFS, ...preferences },
        }),
      };
    if (!url.startsWith("/api/sessions?")) return routes?.(url, init);
    const params = new URL(url, "http://local").searchParams;
    return list({
      query: params.get("q") ?? "",
      offset: Number(params.get("offset") ?? 0),
      limit: Number(params.get("limit") ?? 40),
      signal: init.signal,
    });
  });
  return initStore(emptySnapshot);
}
