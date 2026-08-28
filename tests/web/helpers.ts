import { vi } from "vitest";
import {
  type ActiveSnapshot,
  defaultPreferences,
  type SessionSummary,
} from "../../shared/contracts";

// --- Fetch stubbing ---

export interface RouteResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

export type RouteHandler = (
  url: string,
  init: RequestInit,
) => RouteResponse | undefined | Promise<RouteResponse | undefined>;

export function installFetch(handler: RouteHandler) {
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const route = (await handler(url, init ?? {})) ?? {
      status: 404,
      body: { error: `No mock route for ${url}` },
    };
    if (
      url.startsWith("/api/bootstrap") &&
      (route.status ?? 200) < 400 &&
      route.body &&
      typeof route.body === "object" &&
      "snapshot" in route.body
    ) {
      FakeWebSocket.bootstrapSnapshot = (
        route.body as { snapshot: ActiveSnapshot }
      ).snapshot;
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json", ...route.headers },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export function jsonBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
}

// --- WebSocket stubbing (never connects unless told to) ---

export const TEST_HOST_AUTHORITY = "11111111-1111-4111-8111-111111111111";
export const TEST_SNAPSHOT_DIGEST = "a".repeat(64);

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static bootstrapSnapshot: ActiveSnapshot | undefined;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private opened = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {}
  open(snapshot = FakeWebSocket.bootstrapSnapshot): void {
    if (this.opened) return;
    this.opened = true;
    this.onopen?.({});
    if (snapshot)
      this.emit({
        type: "snapshot",
        authorityId: TEST_HOST_AUTHORITY,
        snapshotDigest: TEST_SNAPSHOT_DIGEST,
        data: snapshot,
      });
  }
  emit(event: unknown): void {
    const wire =
      event &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      (event as { type?: unknown }).type === "snapshot"
        ? {
            authorityId: TEST_HOST_AUTHORITY,
            snapshotDigest: TEST_SNAPSHOT_DIGEST,
            ...event,
          }
        : event;
    this.onmessage?.({ data: JSON.stringify(wire) });
  }
}

export function installFakeWebSocket(): void {
  FakeWebSocket.instances = [];
  FakeWebSocket.bootstrapSnapshot = undefined;
  vi.stubGlobal("WebSocket", FakeWebSocket);
}

// --- Payloads ---

export const DEFAULT_PREFS = defaultPreferences;

type ActiveSnapshotValue = NonNullable<ActiveSnapshot["active"]>;
type ActiveSnapshotOverrides = Omit<
  Partial<ActiveSnapshotValue>,
  "transcriptPage"
> & {
  pageMessages?: unknown[];
  transcriptPage?: Partial<ActiveSnapshotValue["transcriptPage"]>;
};

export function activeSnapshot(
  overrides: ActiveSnapshotOverrides = {},
): ActiveSnapshot {
  const { pageMessages = [], transcriptPage, ...activeOverrides } = overrides;
  const sessionId = activeOverrides.sessionId ?? "s1";
  const active: ActiveSnapshotValue = {
    sessionId,
    sessionName: "Test session",
    cwd: "/proj",
    model: { provider: "kimi-coding", id: "kimi-k3" },
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    projectionHealth: { status: "ok" as const },
    projectionConflict: null,
    stats: {
      contextUsage: { tokens: 12_640, contextWindow: 131_072, percent: 9.64 },
    },
    availableModels: [],
    commands: [],
    ...activeOverrides,
    transcriptPage: {
      sessionId,
      revision: 1,
      viewId: `view-${sessionId}`,
      incarnation: "projection-1",
      appendFromRevision: 1,
      messages: pageMessages,
      hasOlder: false,
      olderCursor: null,
      ...transcriptPage,
    },
  };
  return {
    active,
    runState: "idle",
    sessionStatuses: { [String(active.sessionId)]: { runState: "idle" } },
  };
}

export function sessionSummary(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id: "s1",
    cwd: "/demo",
    project: "demo",
    title: "Previous work",
    created: new Date(Date.now() - 3_600_000).toISOString(),
    modified: new Date(Date.now() - 60_000).toISOString(),
    messageCount: 3,
    ...overrides,
  };
}

export function bootstrapPayload(overrides: Record<string, unknown> = {}) {
  return {
    appName: "inspire",
    authorityId: TEST_HOST_AUTHORITY,
    snapshotDigest: TEST_SNAPSHOT_DIGEST,
    version: "0.1.0",
    piVersion: "0.80.10",
    mock: false,
    preferences: DEFAULT_PREFS,
    availableModels: [
      {
        provider: "kimi-coding",
        id: "kimi-k3",
        name: "Kimi K3",
        reasoning: true,
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        reasoning: true,
      },
    ],
    snapshot: { active: null, runState: "idle", sessionStatuses: {} },
    ...overrides,
  };
}
