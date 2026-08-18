import { vi } from "vitest";
import {
  defaultPreferences,
  type ActiveSnapshot,
  type SessionSummary,
} from "../../shared/contracts";

// --- Fetch stubbing ---

export interface RouteResponse {
  status?: number;
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
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export function jsonBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
}

// --- WebSocket stubbing (never connects unless told to) ---

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {}
  open(): void {
    this.onopen?.({});
  }
  emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

export function installFakeWebSocket(): void {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
}

// --- Payloads ---

export const DEFAULT_PREFS = defaultPreferences;

export function activeSnapshot(
  overrides: Record<string, unknown> = {},
): ActiveSnapshot {
  const active: NonNullable<ActiveSnapshot["active"]> = {
    sessionId: "s1",
    sessionName: "Test session",
    cwd: "/proj",
    model: { provider: "kimi-coding", id: "kimi-k3" },
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    messages: [],
    transcriptPage: {
      sessionId: "s1",
      revision: 1,
      viewId: "view-s1",
      incarnation: "projection-1",
      appendFromRevision: 1,
      messages: [],
      hasOlder: false,
      olderCursor: null,
    },
    projectionHealth: { status: "ok" as const },
    projectionConflict: null,
    stats: {
      contextUsage: { tokens: 12_640, contextWindow: 131_072, percent: 9.64 },
    },
    availableModels: [],
    commands: [],
    ...overrides,
  };
  if (!("transcriptPage" in overrides)) {
    active.transcriptPage = {
      sessionId: String(active.sessionId),
      revision: 1,
      viewId: `view-${String(active.sessionId)}`,
      incarnation: "projection-1",
      appendFromRevision: 1,
      messages: active.messages as unknown[],
      hasOlder: false,
      olderCursor: null,
    };
  }
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
