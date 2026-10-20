import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { expect, vi } from "vitest";
import { createInspireServer } from "../../../server/app.js";
import { AttachmentStore } from "../../../server/attachments.js";
import { PiRpcProcess } from "../../../server/pi-rpc.js";
import { piInstallation } from "../../../server/pi-runtime.js";
import { PreferencesStore } from "../../../server/preferences.js";
import { ResourceStore } from "../../../server/resources.js";
import { RuntimeController } from "../../../server/runtime.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../../server/session-catalog.js";
import type {
  BranchNavigateRequest,
  BranchNavigateResponse,
  BranchTreeResponse,
  HostNativeCommandRequest,
  HostNativeCommandResponse,
  PendingOperationIdentity,
  PendingOperationRequest,
  PendingReadRequest,
  PendingRecovery,
  PromptAcceptedResponse,
  PromptDeliveryRequest,
  PromptDeliveryResponse,
} from "../../../shared/contracts.js";

import { isolatedTestEnvironment } from "./isolated-environment.js";

const PROVIDER = "pi-operation-offline";
const MODEL = "tiny-context-fixture";
const TOKEN = "pi-operation-synthetic-local-token";
const cleanups: Array<() => Promise<void>> = [];

type ObservedEvent = Record<string, unknown> & {
  type: string;
  at: number;
};
interface Observation {
  method: string;
  url: URL;
  body: unknown;
  startedAt: number;
  completedAt?: number;
  status?: number;
  authorityId?: string | null;
  receipt?: PromptDeliveryResponse;
}
interface BrowserClient {
  branchTree(sessionId: string): Promise<BranchTreeResponse>;
  navigateBranch(
    request: BranchNavigateRequest,
  ): Promise<BranchNavigateResponse>;
  nativeCommand(
    request: HostNativeCommandRequest,
  ): Promise<HostNativeCommandResponse>;
  pendingText(request: PendingReadRequest): Promise<{ text: string }>;
  recoverPending(
    sessionId: string,
    identity: PendingOperationIdentity,
  ): Promise<PendingRecovery>;
  abort(
    sessionId: string,
    identity: PendingOperationIdentity,
  ): Promise<PendingRecovery>;
  pendingOperation(request: PendingOperationRequest): Promise<PendingRecovery>;
  clearPending(sessionId: string): Promise<{ ok: boolean }>;
  attachmentPreview(
    id: string,
  ): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  prompt(
    body: PromptDeliveryRequest,
    signal?: AbortSignal,
  ): Promise<PromptAcceptedResponse>;
}

function seedMessage(
  id: string,
  parentId: string,
  role: "user" | "assistant",
  text: string,
  timestamp: number,
): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message:
      role === "user"
        ? { role, content: text, timestamp }
        : {
            role,
            content: [{ type: "text", text }],
            api: "openai-completions",
            provider: PROVIDER,
            model: MODEL,
            // Above the 2048 - 512 threshold, below overflow. The provider's
            // later responses report 72 tokens, so the next prompt won't compact.
            usage: {
              input: 1792,
              output: 8,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 1800,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp,
          },
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

export async function fixture(
  autoCompaction: boolean,
  compactionDelayMs = 35_000,
  modelReplyGate?: Promise<void> | ((requestNumber: number) => Promise<void>),
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-pi-operation-")),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const config = join(directory, "config");
  const sessions = join(directory, "sessions");
  const workspace = join(directory, "workspace");
  const temporary = join(directory, "tmp");
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    APPDATA: join(home, "appdata"),
    LOCALAPPDATA: join(home, "localappdata"),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    PI_CODING_AGENT_DIR: config,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_FIXTURE_COMPACT_DELAY_MS: String(compactionDelayMs),
  };
  await Promise.all(
    [home, config, sessions, workspace, temporary].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  // The Host's public SDK fallback for retry settings must see the same
  // synthetic config as the child, never the user's agent directory.
  for (const [name, value] of Object.entries(environment))
    vi.stubEnv(name, value);
  await writeFile(join(config, "auth.json"), "{}\n");
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({
      defaultProvider: PROVIDER,
      defaultModel: MODEL,
      defaultThinkingLevel: "off",
      defaultProjectTrust: "never",
      enableInstallTelemetry: false,
      compaction: {
        enabled: autoCompaction,
        reserveTokens: 512,
        keepRecentTokens: 64,
      },
      retry: { enabled: false, provider: { maxRetries: 0 } },
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    }),
  );

  const modelRequests: Array<{
    method?: string;
    url?: string;
    body: Record<string, unknown>;
    at: number;
  }> = [];
  const modelServer = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      modelRequests.push({
        method: request.method,
        url: request.url,
        body,
        at: performance.now(),
      });
      if (
        request.method !== "POST" ||
        request.url !== "/v1/chat/completions" ||
        body.model !== MODEL
      ) {
        response.writeHead(400).end("Unexpected synthetic provider request");
        return;
      }
      await (typeof modelReplyGate === "function"
        ? modelReplyGate(modelRequests.length)
        : modelReplyGate);
      if (response.destroyed) return;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const chunk = (
        delta: Record<string, string>,
        finishReason: "stop" | null = null,
      ) =>
        `data: ${JSON.stringify({
          id: `chatcmpl-pi-operation-${modelRequests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: MODEL,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(finishReason
            ? {
                usage: {
                  prompt_tokens: 64,
                  completion_tokens: 8,
                  total_tokens: 72,
                },
              }
            : {}),
        })}\n\n`;
      response.write(
        chunk({
          role: "assistant",
          content: `Synthetic reply ${modelRequests.length}.`,
        }),
      );
      response.write(chunk({}, "stop"));
      response.end("data: [DONE]\n\n");
    } catch {
      response.writeHead(400).end("Invalid synthetic provider request");
    }
  });
  cleanups.push(() => closeServer(modelServer));
  const modelUrl = await listen(modelServer);
  await writeFile(
    join(config, "models.json"),
    JSON.stringify({
      providers: {
        [PROVIDER]: {
          api: "openai-completions",
          apiKey: "non-secret-fixture-placeholder",
          baseUrl: `${modelUrl}/v1`,
          models: [
            {
              id: MODEL,
              name: "Synthetic tiny context",
              input: ["text", "image"],
              reasoning: false,
              contextWindow: 2048,
              maxTokens: 128,
            },
          ],
        },
      },
    }),
  );

  const sessionId = randomUUID();
  const sessionFile = join(sessions, `${sessionId}.jsonl`);
  const timestamp = Date.parse("2026-01-01T00:00:00.000Z");
  const entries: SessionEntry[] = [
    {
      type: "model_change",
      id: "00000001",
      parentId: null,
      timestamp: new Date(timestamp).toISOString(),
      provider: PROVIDER,
      modelId: MODEL,
    },
    {
      type: "thinking_level_change",
      id: "00000002",
      parentId: "00000001",
      timestamp: new Date(timestamp + 1).toISOString(),
      thinkingLevel: "off",
    },
  ];
  for (let index = 0; index < 8; index++) {
    entries.push(
      seedMessage(
        (index + 3).toString(16).padStart(8, "0"),
        entries.at(-1)!.id,
        index % 2 ? "assistant" : "user",
        `Synthetic seed ${index}. `.repeat(30),
        timestamp + index + 2,
      ),
    );
  }
  await writeFile(
    sessionFile,
    `${[
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date(timestamp).toISOString(),
        cwd: workspace,
      },
      ...entries,
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  const record: SessionRecord = {
    id: sessionId,
    path: sessionFile,
    cwd: workspace,
    source: null,
    created: new Date(timestamp),
    modified: new Date(timestamp),
    messageCount: 8,
    firstMessage: "Synthetic seed 0.",
    searchText: "Synthetic seed",
  };
  const catalog: SessionCatalogLike = {
    refresh: async () => [record],
    get: async (id) => (id === sessionId ? record : undefined),
    list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
    listByIds: async () => [],
    listByCwds: async () => [],
    invalidate() {},
  };
  const attachments = new AttachmentStore(join(directory, "uploads"));
  const workers: PiRpcProcess[] = [];
  const piEvents: ObservedEvent[] = [];
  const runtimeEvents: ObservedEvent[] = [];
  const runtime = new RuntimeController(catalog, attachments, (options) => {
    const worker = new PiRpcProcess({
      ...options,
      args: [
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-tools",
        "--no-approve",
        "--session-dir",
        sessions,
        "--model",
        `${PROVIDER}/${MODEL}`,
        "--thinking",
        "off",
        "--system-prompt",
        "You are a synthetic lifecycle fixture. Reply without tools.",
        ...(options.args ?? []),
        "--extension",
        resolve("tests/fixtures/pi-operation-lifecycle-extension.ts"),
      ],
      env: isolatedTestEnvironment(directory, {
        ...options.env,
        ...environment,
      }),
    });
    vi.spyOn(worker, "stop"); // Observe, never replace, real process teardown.
    worker.on("event", (event) =>
      piEvents.push({ ...event, at: performance.now() }),
    );
    workers.push(worker);
    return worker;
  });
  runtime.on("event", (event) =>
    runtimeEvents.push({ ...event, at: performance.now() }),
  );
  const application = createInspireServer({
    token: TOKEN,
    runtime,
    catalog,
    attachments,
    preferences: new PreferencesStore(join(directory, "preferences.json")),
    resources: new ResourceStore(),
    git: {
      status: async () => ({ kind: "not-repository" }),
      diff: async () => {
        throw new Error("Git is outside this fixture");
      },
    },
    mock: false,
    version: "0.0.0-fixture",
    piVersion: piInstallation.version,
    distDir: join(directory, "missing-dist"),
    // Keep the real 20s HTTP window for the long regression. Only the short
    // dialog test scales this observation window; Pi timers are always real.
    ...(autoCompaction ? {} : { promptObservationWindowMs: 100 }),
    // No terminal, update checkers, global models, or real service adapters.
  });
  cleanups.push(() => application.close());
  const baseUrl = await listen(application.server);
  const observations: Observation[] = [];
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal("window", {
    location: new URL(baseUrl),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  vi.stubGlobal("fetch", (async (input, init) => {
    const url = new URL(String(input), baseUrl);
    if (url.origin !== baseUrl)
      throw new Error("Only the synthetic Host origin is allowed");
    const observation: Observation = {
      method: init?.method ?? "GET",
      url,
      body: init?.body,
      startedAt: performance.now(),
    };
    observations.push(observation);
    const response = await nativeFetch(url, init);
    observation.status = response.status;
    observation.authorityId = response.headers.get("X-Inspire-Authority");
    if (response.headers.get("Content-Type")?.includes("application/json"))
      observation.receipt = (await response
        .clone()
        .json()) as PromptDeliveryResponse;
    observation.completedAt = performance.now();
    return response;
  }) satisfies typeof fetch);
  // The server tsconfig intentionally excludes browser sources. A computed
  // import lets Vitest execute the actual client without adding its DOM build
  // graph to the server composite project; the narrow test interface is typed.
  const browserModulePath = resolve("src/api.ts");
  const { createApi } = (await import(browserModulePath)) as {
    createApi(token: string): BrowserClient;
  };
  const client = createApi(TOKEN);
  const operation = () => ({
    operationId: randomUUID(),
    authorityId: application.authorityId,
  });
  const api = {
    ...client,
    recoverPending: (id: string, identity = operation()) =>
      client.recoverPending(id, identity),
    abort: (id: string, identity = operation()) => client.abort(id, identity),
  };
  await runtime.openSession(sessionId);
  await vi.waitFor(
    async () => {
      const snapshot = await runtime.snapshot();
      expect(snapshot.active?.commands).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "await" })]),
      );
      expect(snapshot.active?.projectionConflict).toBeNull();
    },
    { timeout: 10_000 },
  );
  expect(piInstallation.commandPath).toBe(process.env.INSPIRE_PI_COMMAND);
  expect(workers).toHaveLength(1);
  const initial = await runtime.snapshot();
  expect(initial.active?.availableModels).toEqual([
    expect.objectContaining({ provider: PROVIDER, id: MODEL }),
  ]);
  expect(initial.extensionStatuses?.["pi-operation-node"]).toBe(
    process.version,
  );
  return {
    runtime,
    attachments,
    application,
    api,
    workers,
    piEvents,
    runtimeEvents,
    modelRequests,
    observations,
    sessionFile,
    sessionId,
    directory,
    workspace,
    delivery(message: string): PromptDeliveryRequest {
      return {
        sessionId,
        message,
        operationId: randomUUID(),
        authorityId: application.authorityId,
      };
    },
  };
}

export function eventsOf(events: ObservedEvent[], type: string) {
  return events.filter((event) => event.type === type);
}

export async function settled(
  f: Awaited<ReturnType<typeof fixture>>,
  turns: number,
) {
  await vi.waitFor(
    async () => {
      expect(eventsOf(f.runtimeEvents, "agent_settled")).toHaveLength(turns);
      const snapshot = await f.runtime.snapshot();
      expect(snapshot.runState).toBe("idle");
      expect(snapshot.active?.projectionHealth.status).toBe("ok");
      expect(snapshot.active?.projectionConflict).toBeNull();
    },
    { timeout: 10_000 },
  );
}

export async function disposeOperationFixture() {
  const failures: unknown[] = [];
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
  if (failures.length)
    throw new AggregateError(failures, "Pi fixture cleanup failed");
}
