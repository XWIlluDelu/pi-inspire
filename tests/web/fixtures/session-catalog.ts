import type { SessionSummary } from "../../../shared/contracts";
import {
  bootstrapPayload,
  installFetch,
  type RouteHandler,
  type RouteResponse,
} from "../helpers";

// Keep the server cursor/count independent of rendered or curated identities.
export function sessionPage(
  sessions: SessionSummary[],
  total: number,
  offset = 0,
  limit = 40,
) {
  return { sessions, total, offset, limit };
}

function emptyBootstrap(preferences = bootstrapPayload().preferences) {
  return bootstrapPayload({
    preferences,
    snapshot: { active: null, runState: "idle", sessionStatuses: {} },
  });
}

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
    preferences?: Partial<ReturnType<typeof bootstrapPayload>["preferences"]>;
    routes?: RouteHandler;
  } = {},
) {
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: emptyBootstrap({
          ...bootstrapPayload().preferences,
          ...preferences,
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
}
