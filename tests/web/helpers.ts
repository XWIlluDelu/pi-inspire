import { act } from "@testing-library/react";
import { vi } from "vitest";
import {
  type ActiveSnapshot,
  type BootstrapResponse,
  defaultPreferences,
  type HostUpdateStatus,
  type SessionSummary,
} from "../../shared/contracts";

import {
  type HostOperationCommand,
  hostOperationIdentitySchema,
  hostReceipt,
} from "../../shared/host-operations";
import { emptyToolPresentationConfiguration } from "../../shared/tool-presentation-config";

let nextSelection: ActiveSnapshot | undefined;

/** Commit a fixture navigation through the same HTTP owner as production. */
export async function selectSession(
  store: {
    openSession(id: string): Promise<void>;
    deselectSession(): Promise<boolean>;
  },
  snapshot: ActiveSnapshot,
): Promise<void> {
  nextSelection = snapshot;
  try {
    await act(async () => {
      if (snapshot.active) await store.openSession(snapshot.active.sessionId);
      else await store.deselectSession();
    });
  } finally {
    nextSelection = undefined;
  }
}

export function inputReceipt<Command extends HostOperationCommand>(
  command: Command,
  { operationId, authorityId }: Record<string, unknown>,
) {
  return hostReceipt(
    command,
    hostOperationIdentitySchema.parse({ operationId, authorityId }),
  );
}

// --- Fetch stubbing ---

export interface RouteResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

export type RouteHandler = (
  url: string,
  init: RequestInit,
) =>
  | RouteResponse
  | Response
  | undefined
  | Promise<RouteResponse | Response | undefined>;

export function installFetch(handler: RouteHandler) {
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const selected = nextSelection;
    if (
      selected &&
      (selected.active
        ? url === "/api/sessions/open" &&
          jsonBody(init ?? {}).id === selected.active.sessionId
        : url === "/api/sessions/deselect")
    ) {
      nextSelection = undefined;
      return new Response(JSON.stringify(selected), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const route = (await handler(url, init ?? {})) ?? {
      status: 404,
      body: { error: `No mock route for ${url}` },
    };
    if (route instanceof Response) return route;
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

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function installLocalStorage(): void {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
}

// --- WebSocket stubbing (never connects unless told to) ---

export const TEST_HOST_AUTHORITY = "11111111-1111-4111-8111-111111111111";

type SnapshotEnvelope = {
  authorityId?: string;
  updateStatus?: HostUpdateStatus;
  runtimeSequence?: number;
  detailSessionId?: string | null;
  detailRevision?: number;
  missingDetail?: boolean;
};

export class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closeCount = 0;
  send(data: string): void {
    this.sent.push(data);
  }
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  extensions = "";

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = 3;
    this.closeCount++;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  join(data = emptySnapshot, envelope?: SnapshotEnvelope): void {
    if (this.readyState !== 0) return;
    this.open();
    this.emitSnapshot(data, envelope);
  }
  emitSnapshot(data: ActiveSnapshot, envelope?: SnapshotEnvelope): void {
    const interest = this.sent.length
      ? (JSON.parse(this.sent.at(-1)!) as {
          sessionId: string | null;
          revision: number;
        })
      : {
          sessionId: new URL(this.url).searchParams.get("detail") || null,
          revision: 0,
        };
    this.emit({
      type: "snapshot",
      authorityId: TEST_HOST_AUTHORITY,
      updateStatus: updateStatus(),
      detailSessionId: interest.sessionId,
      detailRevision: interest.revision,
      runtimeSequence: data.runtimeSequence,
      ...envelope,
      data,
    });
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
export const emptySnapshot: ActiveSnapshot = {
  active: null,
  sessionStatuses: {},
};

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
    branchRevision: 1,
    sessionId,
    sessionName: "Test session",
    cwd: "/proj",
    model: { provider: "kimi-coding", id: "kimi-k3" },
    thinkingLevel: "medium",
    isStreaming: false,
    projectionHealth: { status: "ok" as const },
    projectionConflict: null,
    stats: {
      contextUsage: { tokens: 12_640, contextWindow: 131_072, percent: 9.64 },
    },
    commands: [],
    ...activeOverrides,
    transcriptPage: {
      sessionId,
      revision: 1,
      viewId: `view-${sessionId}`,
      composerHistoryVersion: "history-1",
      incarnation: "projection-1",
      appendFromRevision: 1,
      messages: pageMessages,
      hasOlder: false,
      ...transcriptPage,
    },
  };
  return {
    active,
    sessionStatuses: { [sessionId]: { runState: "idle" } },
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

export function updateStatus(
  revision = 0,
  overrides: Partial<HostUpdateStatus> = {},
): HostUpdateStatus {
  return {
    revision,
    inspireUpdateCheck: null,
    piUpdateCheck: null,
    inspireUpdateChecking: false,
    piUpdateChecking: false,
    availableUpdateIdentity: null,
    updateSnoozedUntil: null,
    ...overrides,
  };
}

export function bootstrapPayload(overrides: Partial<BootstrapResponse> = {}) {
  return {
    appName: "inspire" as const,
    authorityId: TEST_HOST_AUTHORITY,
    startupSessionId: null,
    version: "0.1.0",
    piVersion: "0.80.10",
    updateStatus: updateStatus(),
    preferences: DEFAULT_PREFS,
    preferenceRevision: 0,
    toolPresentations: emptyToolPresentationConfiguration(),
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
    ...overrides,
  };
}
