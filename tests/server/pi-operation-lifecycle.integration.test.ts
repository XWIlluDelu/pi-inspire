import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInspireServer } from "../../server/app.js";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { piInstallation } from "../../server/pi-runtime.js";
import { PreferencesStore } from "../../server/preferences.js";
import { ResourceStore } from "../../server/resources.js";
import { RuntimeController } from "../../server/runtime.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../server/session-catalog.js";
import type {
  PromptAcceptedResponse,
  PromptDeliveryRequest,
  PromptDeliveryResponse,
} from "../../shared/contracts.js";

const PROVIDER = "pi-operation-offline";
const MODEL = "tiny-context-fixture";
const TOKEN = "pi-operation-synthetic-local-token";
const cleanups: Array<() => Promise<void>> = [];

type ObservedEvent = Record<string, unknown> & { type: string; at: number };
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

async function fixture(autoCompaction: boolean) {
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
              input: ["text"],
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
      env: {
        // PiRpcProcess normally inherits the Host env. Explicitly remove every
        // inherited key (auth, proxies, NODE_OPTIONS, PI payload logging, etc.).
        ...Object.fromEntries(
          Object.keys(process.env).map((key) => [key, undefined]),
        ),
        PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
        ...(process.platform === "win32"
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        ...options.env,
        ...environment,
      },
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
  const api = createApi(TOKEN);
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
  expect(piInstallation.packageRoot).toBe(
    await realpath(resolve("node_modules/@earendil-works/pi-coding-agent")),
  );
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
    application,
    api,
    workers,
    piEvents,
    runtimeEvents,
    modelRequests,
    observations,
    sessionFile,
    sessionId,
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

function eventsOf(events: ObservedEvent[], type: string) {
  return events.filter((event) => event.type === type);
}

async function settled(f: Awaited<ReturnType<typeof fixture>>, turns: number) {
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

afterEach(async () => {
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
});

describe("installed Pi operation lifecycle", () => {
  it("accepts an ordinary browser prompt after 35s of real pre-prompt auto-compaction, then reuses the same worker", async () => {
    const f = await fixture(true);
    const worker = f.workers[0]!;
    const pid = worker.pid;
    expect(pid).toBeTypeOf("number");
    const first = f.delivery("First synthetic prompt after slow preflight.");
    const startedAt = performance.now();
    let completed = false;
    const delivery = f.api.prompt(first);
    void delivery.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );

    await vi.waitFor(
      () => {
        expect(eventsOf(f.piEvents, "compaction_start")).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    const compactStart = eventsOf(f.piEvents, "compaction_start")[0]!;
    expect(compactStart.reason).toBe("threshold");
    expect(eventsOf(f.runtimeEvents, "prompt_pending")[0]).toMatchObject({
      sessionId: f.sessionId,
      sessionStatus: { runState: "queued" },
    });
    expect(f.modelRequests).toHaveLength(0);
    expect(eventsOf(f.piEvents, "agent_start")).toHaveLength(0);

    // Cross the former 30s RPC/browser deadline using real monotonic time.
    await delay(Math.max(0, compactStart.at + 31_000 - performance.now()));
    expect(completed).toBe(false);
    expect(worker.available).toBe(true);
    expect(worker.pid).toBe(pid);
    expect(worker.stop).not.toHaveBeenCalled();
    expect(worker.hasPendingRequest("prompt")).toBe(true);
    expect(f.modelRequests).toHaveLength(0);
    expect(eventsOf(f.piEvents, "agent_start")).toHaveLength(0);
    await expect(worker.request({ type: "get_state" })).resolves.toMatchObject({
      sessionId: f.sessionId,
      isStreaming: false,
      isCompacting: true,
    });
    expect(f.observations[0]).toMatchObject({
      method: "POST",
      status: 202,
      authorityId: first.authorityId,
      receipt: {
        accepted: false,
        pending: true,
        operationId: first.operationId,
        authorityId: first.authorityId,
      },
    });
    expect(
      f.observations.some((observation) => observation.method === "GET"),
    ).toBe(true);

    await expect(delivery).resolves.toMatchObject({ accepted: true });
    expect(performance.now() - startedAt).toBeGreaterThan(30_000);
    await settled(f, 1);
    const compactEnd = eventsOf(f.piEvents, "compaction_end")[0]!;
    expect(compactEnd).toMatchObject({
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: {
        tokensBefore: 1800,
        details: {
          fixture: "pi-operation-lifecycle",
          reason: "threshold",
          elapsedMs: expect.any(Number),
        },
      },
    });
    const details = (compactEnd.result as { details: { elapsedMs: number } })
      .details;
    // Allow timer granularity; the child always requests the full 35s delay.
    expect(details.elapsedMs).toBeGreaterThanOrEqual(34_900);
    expect(compactEnd.at - compactStart.at).toBeGreaterThan(30_000);
    expect(eventsOf(f.piEvents, "agent_start")[0]!.at).toBeGreaterThanOrEqual(
      compactEnd.at,
    );
    // HTTP and stdout are independent transports; assert their long preflight
    // interval, not which descriptor the Host's event loop happened to read first.
    expect(f.modelRequests[0]!.at - compactStart.at).toBeGreaterThan(30_000);
    expect(eventsOf(f.runtimeEvents, "compaction_end")[0]).toMatchObject({
      sessionStatus: { runState: "queued" },
    });

    const firstObservations = [...f.observations];
    expect(
      firstObservations.filter((observation) => observation.method === "POST"),
    ).toHaveLength(1);
    expect(firstObservations.at(-1)?.receipt).toMatchObject({ accepted: true });
    for (const observation of firstObservations) {
      expect(observation.status).toBe(202);
      expect(observation.authorityId).toBe(first.authorityId);
      expect(observation.completedAt! - observation.startedAt).toBeLessThan(
        30_000,
      );
      if (observation.method === "GET") {
        expect(observation.url.pathname).toBe(
          `/api/prompt/${first.operationId}`,
        );
        expect(observation.url.searchParams.get("authorityId")).toBe(
          first.authorityId,
        );
        expect(observation.body).toBeUndefined();
      }
    }
    expect(JSON.parse(String(firstObservations[0]!.body))).toEqual(first);

    const second = f.delivery(
      "Second ordinary synthetic prompt on the same worker.",
    );
    await expect(f.api.prompt(second)).resolves.toMatchObject({
      accepted: true,
    });
    await settled(f, 2);
    expect(f.workers).toHaveLength(1);
    expect(worker.available).toBe(true);
    expect(worker.pid).toBe(pid);
    expect(worker.stop).not.toHaveBeenCalled();
    expect(eventsOf(f.piEvents, "compaction_start")).toHaveLength(1);
    expect(eventsOf(f.piEvents, "extension_error")).toEqual([]);
    expect(eventsOf(f.runtimeEvents, "runtime_error")).toEqual([]);
    expect(eventsOf(f.runtimeEvents, "session_projection_conflict")).toEqual(
      [],
    );
    expect(f.modelRequests).toHaveLength(2);
    expect(f.modelRequests.map((request) => request.url)).toEqual([
      "/v1/chat/completions",
      "/v1/chat/completions",
    ]);
    expect(
      f.observations.filter((observation) => observation.method === "POST"),
    ).toHaveLength(2);
    // This is only the JSONL generated in this test's private fixture directory.
    const written = (await readFile(f.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as SessionEntry[];
    const newMessages = written
      .filter((entry): entry is SessionMessageEntry => entry.type === "message")
      .slice(8);
    expect(newMessages.map((entry) => entry.message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(newMessages[0]!.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: first.message }],
    });
    expect(newMessages[2]!.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: second.message }],
    });
    expect(written.filter((entry) => entry.type === "compaction")).toHaveLength(
      1,
    );
    expect(
      written.findIndex((entry) => entry.type === "compaction"),
    ).toBeLessThan(written.indexOf(newMessages[0]!));
  }, 90_000);

  it("keeps /await pending until a UI answer and lets explicit Stop interrupt the next preflight outside the writer FIFO", async () => {
    const f = await fixture(false);
    const worker = f.workers[0]!;
    const pid = worker.pid;
    const answered = f.api.prompt(f.delivery("/await"));
    let completed = false;
    void answered.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    await vi.waitFor(() =>
      expect(f.observations[0]?.receipt).toMatchObject({ pending: true }),
    );
    const pending = await f.runtime.snapshot();
    expect(pending.runState).toBe("queued");
    expect(pending.pendingExtensionUiRequests).toHaveLength(1);
    const dialog = pending.pendingExtensionUiRequests![0]!;
    expect(dialog).toMatchObject({ method: "confirm", sessionId: f.sessionId });
    expect(completed).toBe(false);
    await f.runtime.extensionUiResponse({
      sessionId: f.sessionId,
      id: dialog.id,
      confirmed: true,
    });
    await expect(answered).resolves.toMatchObject({ accepted: true });
    expect((await f.runtime.snapshot()).runState).toBe("idle");
    expect(worker.pid).toBe(pid);
    expect(worker.stop).not.toHaveBeenCalled();
    expect(f.modelRequests).toHaveLength(0);

    const stopped = f.api.prompt(f.delivery("/await"));
    void stopped.catch(() => {}); // The explicit Stop may reject before we await it.
    await vi.waitFor(async () => {
      expect(
        (await f.runtime.snapshot()).pendingExtensionUiRequests,
      ).toHaveLength(1);
    });
    const stopStarted = performance.now();
    await f.runtime.abort(f.sessionId);
    expect(performance.now() - stopStarted).toBeLessThan(5_000);
    await expect(stopped).rejects.toMatchObject({ outcomeUnknown: true });
    expect(worker.stop).toHaveBeenCalledWith("prompt");
    expect(worker.available).toBe(false);
    expect(worker.pid).toBeNull();
    expect(f.workers).toHaveLength(1);
    const final = await f.runtime.snapshot();
    expect(final.pendingExtensionUiRequests).toEqual([]);
    expect(final.runState).not.toBe("queued");
    expect(f.modelRequests).toHaveLength(0);
  }, 20_000);
});
