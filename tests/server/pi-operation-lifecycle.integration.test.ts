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
import { delimiter, dirname, join, resolve } from "node:path";
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
  BranchNavigateRequest,
  BranchNavigateResponse,
  BranchTreeResponse,
  HostNativeCommandRequest,
  HostNativeCommandResponse,
  PendingReadRequest,
  PendingRecovery,
  PromptAcceptedResponse,
  PromptDeliveryRequest,
  PromptDeliveryResponse,
} from "../../shared/contracts.js";
import { pendingTextSummary } from "../../shared/pending-preview.js";

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
  branchTree(sessionId: string): Promise<BranchTreeResponse>;
  navigateBranch(
    request: BranchNavigateRequest,
  ): Promise<BranchNavigateResponse>;
  nativeCommand(
    request: HostNativeCommandRequest,
  ): Promise<HostNativeCommandResponse>;
  pendingText(request: PendingReadRequest): Promise<{ text: string }>;
  recoverPending(sessionId: string): Promise<PendingRecovery>;
  abort(sessionId: string): Promise<PendingRecovery>;
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

async function fixture(
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

describe("native shell input", () => {
  it("streams direct native results, preserves cwd/context and reopens excluded results without a model turn", async () => {
    const f = await fixture(false);
    const included = f.delivery(
      "!printf 'NATIVE_INCLUDED'; pwd; sleep 0.2; printf 'TAIL'",
    );
    await f.api.prompt(included);
    await f.api.prompt(included); // Reobserving the same receipt must not rerun a shell.
    await f.api.prompt(f.delivery("!!printf 'NATIVE_EXCLUDED'"));
    expect(f.modelRequests).toHaveLength(0);
    expect(eventsOf(f.piEvents, "agent_start")).toHaveLength(0);
    const deltas = eventsOf(f.piEvents, "bash_execution_update");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.every((event) => typeof event.id === "string")).toBe(true);
    expect(
      eventsOf(f.runtimeEvents, "message_update").some((event) =>
        (event.message as Record<string, unknown>)?.output
          ?.toString()
          .includes("NATIVE_INCLUDED"),
      ),
    ).toBe(true);
    const snapshot = await f.runtime.snapshot();
    const bash = snapshot.active!.transcriptPage.messages.filter(
      (message) =>
        (message as Record<string, unknown>).role === "bashExecution",
    ) as Array<Record<string, unknown>>;
    expect(bash).toHaveLength(2);
    expect(bash[0]).toMatchObject({
      exitCode: 0,
      cancelled: false,
      excludeFromContext: false,
    });
    expect(bash[0]!.output).toContain(f.workspace);
    expect(bash[1]).toMatchObject({
      output: "NATIVE_EXCLUDED",
      excludeFromContext: true,
    });
    expect(snapshot.bashRunning).toBe(false);
    expect(snapshot.active?.projectionConflict).toBeNull();
    await f.api.prompt(f.delivery("Explicit model turn."));
    await settled(f, 1);
    const modelContext = JSON.stringify(f.modelRequests[0]!.body.messages);
    expect(modelContext).toContain("NATIVE_INCLUDED");
    expect(modelContext).not.toContain("NATIVE_EXCLUDED");
    const history = await f.runtime.composerHistory(f.sessionId);
    expect(history.entries.map((entry) => entry.text)).toContain(
      "!!printf 'NATIVE_EXCLUDED'",
    );
    await f.runtime.nativeCommand({
      sessionId: f.sessionId,
      command: "reload",
    });
    const reopened = (await f.runtime.snapshot()).active!.transcriptPage
      .messages as Array<Record<string, unknown>>;
    expect(
      reopened.filter((message) => message.role === "bashExecution"),
    ).toHaveLength(2);
    expect(
      reopened.some(
        (message) =>
          message.output === "NATIVE_EXCLUDED" &&
          message.excludeFromContext === true,
      ),
    ).toBe(true);
    const persisted = await readFile(f.sessionFile, "utf8");
    expect(persisted).toContain('"role":"bashExecution"');
    expect(persisted).toContain('"excludeFromContext":true');
  }, 25_000);

  it("honors extension results/custom operations, nonzero status and native truncation metadata", async () => {
    const f = await fixture(false);
    await f.api.prompt(f.delivery("!!fixture-hook"));
    await f.api.prompt(f.delivery("!fixture-ops"));
    await f.api.prompt(f.delivery("!head -c 80000 /dev/zero | tr '\\000' x"));
    const snapshot = await f.runtime.snapshot();
    const messages = snapshot.active!.transcriptPage.messages as Array<
      Record<string, unknown>
    >;
    expect(
      messages.find((message) => message.command === "fixture-hook"),
    ).toMatchObject({
      output: "EXTENSION_BASH_RESULT",
      exitCode: 7,
      excludeFromContext: true,
    });
    expect(snapshot.extensionStatuses?.["fixture-user-bash"]).toBe(
      `true:${f.workspace}`,
    );
    expect(
      messages.find((message) => message.command === "fixture-ops")?.output,
    ).toContain("EXTENSION_CUSTOM_OPERATIONS");
    const truncated = messages.find((message) =>
      String(message.command).startsWith("head -c"),
    )!;
    expect(truncated).toMatchObject({ exitCode: 0, truncated: true });
    expect(truncated.fullOutputPath).toEqual(expect.any(String));
    expect(String(truncated.fullOutputPath)).toContain(f.directory);
    expect((await readFile(String(truncated.fullOutputPath))).length).toBe(
      80000,
    );
    expect(f.modelRequests).toHaveLength(0);
    expect(snapshot.active?.projectionConflict).toBeNull();
  }, 20_000);

  it("uses abort_bash without model abort/dequeue and rejects a second shell while one is running", async () => {
    const f = await fixture(false);
    const worker = f.workers[0]!;
    const requests = vi.spyOn(worker, "request");
    const running = f.api.prompt(
      f.delivery("!printf 'CANCEL_READY'; sleep 30"),
    );
    await vi.waitFor(async () =>
      expect((await f.runtime.snapshot()).bashRunning).toBe(true),
    );
    await expect(f.api.prompt(f.delivery("!echo second"))).rejects.toThrow(
      /already running/,
    );
    await f.api.abort(f.sessionId);
    await running;
    expect(
      requests.mock.calls.some(([command]) => command.type === "abort_bash"),
    ).toBe(true);
    expect(
      requests.mock.calls.some(
        ([command]) =>
          command.type === "abort" || command.type === "clear_queue",
      ),
    ).toBe(false);
    expect(worker.stop).not.toHaveBeenCalled();
    const snapshot = await f.runtime.snapshot();
    expect(snapshot.bashRunning).toBe(false);
    const cancelled = (
      snapshot.active!.transcriptPage.messages as Array<Record<string, unknown>>
    ).find((message) => message.role === "bashExecution");
    expect(cancelled).toMatchObject({
      cancelled: true,
      command: "printf 'CANCEL_READY'; sleep 30",
    });
    expect(snapshot.active?.projectionConflict).toBeNull();
    expect(f.modelRequests).toHaveLength(0);
  }, 20_000);

  it("keeps extension-hook dialogs answerable and retires only the selected worker on explicit hook Stop", async () => {
    const f = await fixture(false);
    const first = f.api.prompt(f.delivery("!fixture-await-bash"));
    await vi.waitFor(async () =>
      expect(
        (await f.runtime.snapshot()).pendingExtensionUiRequests,
      ).toHaveLength(1),
    );
    const dialog = (await f.runtime.snapshot()).pendingExtensionUiRequests![0]!;
    await f.runtime.extensionUiResponse({
      sessionId: f.sessionId,
      id: dialog.id,
      confirmed: true,
    });
    await first;
    expect(f.workers[0]!.stop).not.toHaveBeenCalled();
    const stopped = f.api.prompt(f.delivery("!fixture-await-bash"));
    void stopped.catch(() => {});
    await vi.waitFor(async () =>
      expect(
        (await f.runtime.snapshot()).pendingExtensionUiRequests,
      ).toHaveLength(1),
    );
    await f.api.abort(f.sessionId);
    await expect(stopped).rejects.toMatchObject({ outcomeUnknown: true });
    expect(f.workers[0]!.stop).toHaveBeenCalledWith("bash");
    expect((await f.runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);
    const final = await f.runtime.snapshot();
    expect(final.bashRunning).toBe(false);
    const interrupted = (
      final.active!.transcriptPage.messages as Array<Record<string, unknown>>
    ).find((message) => message.__inspireBashInterrupted === true);
    expect(interrupted).toMatchObject({
      command: "fixture-await-bash",
      __inspireBashRunning: false,
      __inspireBashError: expect.stringContaining("result was confirmed"),
    });
    expect(interrupted?.exitCode).toBeUndefined();
    expect(interrupted?.cancelled).toBeUndefined();
    expect(
      (
        final.active!.transcriptPage.messages as Array<Record<string, unknown>>
      ).some((message) => message.__inspireBashRunning === true),
    ).toBe(false);
    expect(
      (await readFile(f.sessionFile, "utf8")).split("HOOK_CONFIRMED"),
    ).toHaveLength(2);
    expect(f.modelRequests).toHaveLength(0);
  }, 20_000);

  it("settles streamed output honestly when its isolated worker exits unexpectedly", async () => {
    const f = await fixture(false);
    const running = f.api.prompt(f.delivery("!printf 'BEFORE_EXIT'; sleep 30"));
    void running.catch(() => {});
    await vi.waitFor(() =>
      expect(
        f.runtimeEvents.some(
          (event) =>
            (event.message as Record<string, unknown>)?.output ===
            "BEFORE_EXIT",
        ),
      ).toBe(true),
    );
    const pid = f.workers[0]!.pid;
    expect(pid).toEqual(expect.any(Number));
    process.kill(pid!, "SIGKILL"); // This fixture-created worker, never a live session.
    await expect(running).rejects.toMatchObject({ outcomeUnknown: true });
    const snapshot = await f.runtime.snapshot();
    expect(snapshot.bashRunning).toBe(false);
    expect(
      (
        snapshot.active!.transcriptPage.messages as Array<
          Record<string, unknown>
        >
      ).find((message) => message.role === "bashExecution"),
    ).toMatchObject({
      output: "BEFORE_EXIT",
      __inspireBashRunning: false,
      __inspireBashInterrupted: true,
    });
    expect(await readFile(f.sessionFile, "utf8")).not.toContain("BEFORE_EXIT");
    expect(f.modelRequests).toHaveLength(0);
  }, 20_000);

  it("accepts explicit model input during a shell and gives model Stop first ownership", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const f = await fixture(false, 35_000, gate);
    const requests = vi.spyOn(f.workers[0]!, "request");
    const shell = f.api.prompt(
      f.delivery("!printf 'SHELL_ACTIVE'; sleep 2; printf 'SHELL_DONE'"),
    );
    try {
      await vi.waitFor(async () =>
        expect((await f.runtime.snapshot()).bashRunning).toBe(true),
      );
      expect((await f.runtime.snapshot()).runState).toBe("idle");
      await f.api.prompt(f.delivery("Explicit model input during shell."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      await f.api.abort(f.sessionId);
      expect(
        requests.mock.calls.some(([command]) => command.type === "abort"),
      ).toBe(true);
      expect(
        requests.mock.calls.some(([command]) => command.type === "abort_bash"),
      ).toBe(false);
      expect((await f.runtime.snapshot()).bashRunning).toBe(true);
      await shell;
      const messages = (await f.runtime.snapshot()).active!.transcriptPage
        .messages as Array<Record<string, unknown>>;
      expect(
        messages.find((message) => message.role === "bashExecution"),
      ).toMatchObject({
        output: "SHELL_ACTIVESHELL_DONE",
        cancelled: false,
        exitCode: 0,
      });
      expect(f.modelRequests).toHaveLength(1);
    } finally {
      release();
    }
  }, 20_000);

  it("executes during native pre-prompt compaction without joining the model queue", async () => {
    const f = await fixture(true, 1_500);
    const model = f.api.prompt(f.delivery("Model input that compacts first."));
    await vi.waitFor(async () =>
      expect((await f.runtime.snapshot()).runState).toBe("compacting"),
    );
    await f.api.prompt(f.delivery("!!printf 'WHILE_COMPACTING'"));
    expect((await f.runtime.snapshot()).runState).toBe("compacting");
    expect(f.modelRequests).toHaveLength(0);
    await model;
    await settled(f, 1);
    expect(f.modelRequests).toHaveLength(1);
    expect(
      (await f.runtime.snapshot()).active!.transcriptPage.messages.some(
        (message) =>
          (message as Record<string, unknown>).output === "WHILE_COMPACTING",
      ),
    ).toBe(true);
  }, 20_000);

  it("runs alongside an agent and persists deferred shell output at settlement without another model turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const f = await fixture(false, 35_000, gate);
    try {
      await f.api.prompt(f.delivery("Background model turn."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      await f.api.prompt(f.delivery("!printf 'WHILE_MODEL_ACTIVE'"));
      expect((await f.runtime.snapshot()).runState).toBe("running");
      expect(await readFile(f.sessionFile, "utf8")).not.toContain(
        "WHILE_MODEL_ACTIVE",
      );
      expect(
        (await f.runtime.snapshot()).active!.transcriptPage.messages.some(
          (message) =>
            (message as Record<string, unknown>).output ===
            "WHILE_MODEL_ACTIVE",
        ),
      ).toBe(true);
      release();
      await settled(f, 1);
      expect(await readFile(f.sessionFile, "utf8")).toContain(
        "WHILE_MODEL_ACTIVE",
      );
      expect(f.modelRequests).toHaveLength(1);
      expect(
        (await f.runtime.snapshot()).active!.transcriptPage.messages.filter(
          (message) =>
            (message as Record<string, unknown>).role === "bashExecution",
        ),
      ).toHaveLength(1);
    } finally {
      release();
    }
  }, 20_000);
});

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

async function compactThenReturnToEarlierPoint(
  f: Awaited<ReturnType<typeof fixture>>,
) {
  await f.api.nativeCommand({ sessionId: f.sessionId, command: "compact" });
  const tree = await f.api.branchTree(f.sessionId);
  await f.api.navigateBranch({
    sessionId: f.sessionId,
    revision: tree.revision,
    targetId: "00000008",
    mode: "switch",
  });
}

describe("native manual compaction cancellation", () => {
  it.each(["current", "earlier"] as const)(
    "cancels manual compaction on the %s branch without replacing its worker or mistaking an old checkpoint for completion",
    async (branch) => {
      const f = await fixture(false, 500);
      const previousCompactions = branch === "earlier" ? 1 : 0;
      if (branch === "earlier") await compactThenReturnToEarlierPoint(f);
      const worker = f.workers[0]!;
      const pid = worker.pid;
      const requests = vi.spyOn(worker, "request");
      const compacting = f.api.nativeCommand({
        sessionId: f.sessionId,
        command: "compact",
      });
      void compacting.catch(() => {});
      await vi.waitFor(() =>
        expect(eventsOf(f.piEvents, "compaction_start")).toHaveLength(
          previousCompactions + 1,
        ),
      );
      expect(await worker.request({ type: "get_state" })).toMatchObject({
        isCompacting: true,
      });
      // An earlier-branch view intentionally has a read-only navigation lease.
      // Current-branch admission additionally verifies Pending recovery.
      const pending =
        branch === "current"
          ? f.api.prompt({
              ...f.delivery("Never resume this pending input."),
              behavior: "followUp",
            })
          : null;
      if (pending) {
        void pending.catch(() => {});
        await vi.waitFor(async () =>
          expect((await f.runtime.snapshot()).pendingQueues?.totalCount).toBe(
            1,
          ),
        );
      }
      expect(await f.api.abort(f.sessionId)).toEqual({
        steering: [],
        followUp: pending ? ["Never resume this pending input."] : [],
      });
      if (pending)
        await expect(pending).rejects.toMatchObject({
          code: "PROMPT_RECOVERED",
        });
      await expect(compacting).resolves.toMatchObject({
        command: "compact",
        outcome: "cancelled",
      });
      const cancelled = await f.runtime.snapshot();
      expect(cancelled.runState).toBe("aborted");
      expect(cancelled.active?.projectionConflict).toBeNull();
      expect(cancelled.pendingQueues?.totalCount).toBe(0);
      expect(
        cancelled.extensionStatuses?.["pi-operation-compaction-count"],
      ).toBe(String(previousCompactions + 1));
      expect(eventsOf(f.runtimeEvents, "compaction_end").at(-1)).toMatchObject({
        aborted: true,
      });
      expect(
        (await readFile(f.sessionFile, "utf8")).match(/"type":"compaction"/g) ??
          [],
      ).toHaveLength(previousCompactions);
      expect(
        requests.mock.calls
          .filter(([command]) =>
            ["clear_queue", "abort"].includes(String(command.type)),
          )
          .map(([command]) => command.type),
      ).toEqual(["clear_queue", "abort"]);
      expect(worker.stop).not.toHaveBeenCalled();
      expect(worker.pid).toBe(pid);
      expect(worker.available).toBe(true);
      await expect(
        f.api.nativeCommand({
          sessionId: f.sessionId,
          command: "compact",
        }),
      ).resolves.toMatchObject({ outcome: "completed" });
      expect(
        (await f.runtime.snapshot()).extensionStatuses?.[
          "pi-operation-compaction-count"
        ],
      ).toBe(String(previousCompactions + 2));
      expect(f.workers).toHaveLength(1);
      expect(worker.pid).toBe(pid);
      expect(worker.stop).not.toHaveBeenCalled();
      expect(
        (await readFile(f.sessionFile, "utf8")).match(/"type":"compaction"/g),
      ).toHaveLength(previousCompactions + 1);
      expect(eventsOf(f.runtimeEvents, "runtime_error")).toEqual([]);
      expect(f.modelRequests).toHaveLength(0);
    },
    20_000,
  );

  it("retires a genuinely unresponsive compaction hook only after native cancellation cannot settle it", async () => {
    const f = await fixture(false, 0);
    const worker = f.workers[0]!;
    const requests = vi.spyOn(worker, "request");
    const compacting = f.api.nativeCommand({
      sessionId: f.sessionId,
      command: "compact",
      argument: "fixture-ignore-cancellation",
    });
    await vi.waitFor(async () =>
      expect(
        (await f.runtime.snapshot()).extensionStatuses?.[
          "pi-operation-compaction-count"
        ],
      ).toBe("1"),
    );
    const abort = f.api.abort(f.sessionId);
    await vi.waitFor(() =>
      expect(
        requests.mock.calls.some(([command]) => command.type === "abort"),
      ).toBe(true),
    );
    expect(worker.stop).not.toHaveBeenCalled();
    await abort;
    await expect(compacting).resolves.toMatchObject({ outcome: "cancelled" });
    expect(worker.stop).toHaveBeenCalledWith("compact");
    expect(worker.available).toBe(false);
    expect(worker.pid).toBeNull();
    expect((await f.runtime.snapshot()).runState).toBe("aborted");
    expect((await f.runtime.snapshot()).active?.projectionConflict).toBeNull();
    expect(await readFile(f.sessionFile, "utf8")).not.toContain(
      '"type":"compaction"',
    );
    expect(f.modelRequests).toHaveLength(0);
  }, 20_000);

  it("reports a committed checkpoint as completed when a later native custom entry and suspended hook race Stop", async () => {
    const f = await fixture(false, 0);
    await compactThenReturnToEarlierPoint(f);
    const worker = f.workers[0]!;
    const compacting = f.api.nativeCommand({
      sessionId: f.sessionId,
      command: "compact",
      argument: "fixture-post-compact",
    });
    void compacting.catch(() => {});
    // Host projection reconciliation may await the still-running compact receipt.
    // Observe the native hook boundary directly, without waiting on that reader.
    await vi.waitFor(() =>
      expect(f.piEvents).toContainEqual(
        expect.objectContaining({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "pi-operation-compaction",
          statusText: "persisted-waiting",
        }),
      ),
    );
    await f.api.abort(f.sessionId);
    await expect(compacting).resolves.toMatchObject({ outcome: "completed" });
    expect((await f.runtime.snapshot()).runState).toBe("idle");
    expect(eventsOf(f.runtimeEvents, "compaction_end").at(-1)).toMatchObject({
      result: {},
    });
    expect(
      eventsOf(f.runtimeEvents, "compaction_end").at(-1)!.aborted,
    ).not.toBe(true);
    expect(worker.stop).toHaveBeenCalledWith("compact");
    const entries = (await readFile(f.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as SessionEntry[];
    const compactions = entries.filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(2);
    expect(compactions.at(-1)?.parentId).toBe("00000008");
    expect(entries.at(-1)).toMatchObject({
      type: "custom",
      customType: "fixture-after-compaction",
    });
    expect(f.modelRequests).toHaveLength(0);
  }, 20_000);
});

describe("native Pending recovery", () => {
  it("recovers complete queued text without stopping and Stop never runs pending input", async () => {
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolveModel) => {
      releaseModel = resolveModel;
    });
    try {
      const f = await fixture(false, 0, modelGate);
      await f.api.prompt(f.delivery("Keep this synthetic task active."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      const longSteer = `${"long queued input ".repeat(200)}EXACT_END`;
      for (const [message, behavior] of [
        ["follow one", "followUp"],
        [longSteer, "steer"],
        ["steer two", "steer"],
        ["follow two", "followUp"],
      ] as const)
        await f.api.prompt({ ...f.delivery(message), behavior });
      const snapshot = await f.runtime.snapshot();
      expect(snapshot.pendingQueues!.totalCount).toBe(4);
      expect(snapshot.pendingQueues!.steering[0]!.textPreview).toHaveLength(
        512,
      );
      expect(snapshot.pendingQueues!.steering[0]!.textPreview).toMatch(
        /…\n.*EXACT_END$/,
      );
      const read = {
        sessionId: f.sessionId,
        viewId: snapshot.active!.transcriptPage.viewId,
        revision: snapshot.pendingQueues!.revision,
      };
      await expect(
        f.api.pendingText({ ...read, itemId: "text-steer-0" }),
      ).resolves.toEqual({ text: longSteer });
      await expect(f.api.pendingText(read)).resolves.toEqual({
        text: `1. ${longSteer}\n2. steer two\n3. follow one\n4. follow two`,
      });
      expect((await f.runtime.snapshot()).pendingQueues).toEqual(
        snapshot.pendingQueues,
      );
      const restored = await f.api.recoverPending(f.sessionId);
      expect(restored).toEqual({
        steering: [longSteer, "steer two"],
        followUp: ["follow one", "follow two"],
      });
      expect((await f.runtime.snapshot()).pendingQueues!.totalCount).toBe(0);
      expect((await f.runtime.snapshot()).runState).toBe("running");
      expect(f.workers[0]!.stop).not.toHaveBeenCalled();
      await f.api.prompt({
        ...f.delivery("Never run this after Stop."),
        behavior: "followUp",
      });
      await expect(f.api.abort(f.sessionId)).resolves.toEqual({
        steering: [],
        followUp: ["Never run this after Stop."],
      });
      await vi.waitFor(() =>
        expect(eventsOf(f.runtimeEvents, "agent_settled")).toHaveLength(1),
      );
      releaseModel();
      await delay(250);
      expect(f.modelRequests).toHaveLength(1);
      const state = await f.workers[0]!.request({ type: "get_state" });
      expect(state).toMatchObject({
        isStreaming: false,
        pendingMessageCount: 0,
      });
      expect(eventsOf(f.runtimeEvents, "runtime_error")).toEqual([]);
      expect(eventsOf(f.runtimeEvents, "session_projection_conflict")).toEqual(
        [],
      );
    } finally {
      releaseModel?.();
    }
  }, 30_000);

  it("recovers and resends mixed/duplicate/image-only input, discards copies, and restores both modes on Stop", async () => {
    let releaseModel!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseModel = resolveGate;
    });
    try {
      const f = await fixture(false, 0, gate);
      await f.api.prompt(
        f.delivery("Keep mixed pending-image recovery active."),
      );
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      );
      const gif = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      );
      const add = async (bytes: Buffer, name: string) =>
        f.attachments.add({
          originalname: name,
          mimetype: name.endsWith("png") ? "image/png" : "image/gif",
          size: bytes.length,
          buffer: bytes,
        } as Express.Multer.File);
      const first = await add(png, "first.png");
      const second = await add(gif, "second.gif");
      const duplicate = await add(png, "duplicate.png");
      const imageOnly = await add(gif, "image-only.gif");
      for (const [image, behavior, text] of [
        [first, "steer", "same caption"],
        [second, "followUp", "same caption"],
        [duplicate, "steer", "same caption"],
        [imageOnly, "followUp", ""],
      ] as const)
        await f.api.prompt({
          ...f.delivery(text),
          behavior,
          attachmentIds: [image.id],
        });
      const recovered = await f.api.recoverPending(f.sessionId);
      expect(recovered).toEqual({
        steering: ["same caption", "same caption"],
        followUp: ["same caption", ""],
        attachments: [first, duplicate, second, imageOnly],
        authorityId: f.application.authorityId,
      });
      for (const image of recovered.attachments!)
        expect((await f.api.attachmentPreview(image.id)).size).toBe(image.size);
      const merged = [...recovered.steering, ...recovered.followUp].join(
        "\n\n",
      );
      await f.api.prompt({
        ...f.delivery(merged),
        behavior: "followUp",
        attachmentIds: recovered.attachments!.map((image) => image.id),
      });
      expect(
        (await f.runtime.snapshot()).pendingQueues!.followUp[0],
      ).toMatchObject({
        imageCount: 4,
        textLength: merged.trim().length,
      });
      await f.api.clearPending(f.sessionId);
      for (const image of recovered.attachments!)
        await expect(f.api.attachmentPreview(image.id)).rejects.toMatchObject({
          status: 404,
        });
      const stopSteer = await add(png, "stop-steer.png");
      const stopFollow = await add(gif, "stop-follow.gif");
      await f.api.prompt({
        ...f.delivery("stop caption"),
        behavior: "steer",
        attachmentIds: [stopSteer.id],
      });
      await f.api.prompt({
        ...f.delivery(""),
        behavior: "followUp",
        attachmentIds: [stopFollow.id],
      });
      expect(await f.api.abort(f.sessionId)).toEqual({
        steering: ["stop caption"],
        followUp: [""],
        attachments: [stopSteer, stopFollow],
        authorityId: f.application.authorityId,
      });
      for (const image of [stopSteer, stopFollow])
        expect((await f.api.attachmentPreview(image.id)).size).toBe(image.size);
      expect(f.modelRequests).toHaveLength(1);
    } finally {
      releaseModel?.();
    }
  }, 30_000);

  it.each([
    { label: "image-only Steer", mode: "steer", caption: "" },
    { label: "image-only Queue", mode: "followUp", caption: "" },
    {
      label: "same-caption Queue",
      mode: "followUp",
      caption: "long same caption ".repeat(40).trim(),
    },
  ] as const)(
    "keeps only unconsumed $label content through projection, full copy and recovery",
    async ({ mode, caption }) => {
      let releaseFirst!: () => void;
      let releaseLater!: () => void;
      const first = new Promise<void>((resolveGate) => {
        releaseFirst = resolveGate;
      });
      const later = new Promise<void>((resolveGate) => {
        releaseLater = resolveGate;
      });
      try {
        const f = await fixture(false, 0, (number) =>
          number === 1 ? first : later,
        );
        await f.api.prompt(f.delivery("Keep image-only consumption active."));
        await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
        const bytes = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
          "base64",
        );
        const image = await f.attachments.add({
          originalname: "consumed.png",
          mimetype: "image/png",
          size: bytes.length,
          buffer: bytes,
        } as Express.Multer.File);
        await f.api.prompt({
          ...f.delivery(caption),
          behavior: mode,
          attachmentIds: [image.id],
        });
        const admitted = await f.runtime.snapshot();
        expect(admitted.pendingQueues!.totalCount).toBe(1);
        const staleRead = {
          sessionId: f.sessionId,
          viewId: admitted.active!.transcriptPage.viewId,
          revision: admitted.pendingQueues!.revision,
          itemId: `text-${mode}-0`,
        };
        releaseFirst();
        await vi.waitFor(() => expect(f.modelRequests).toHaveLength(2));
        expect((await f.runtime.snapshot()).pendingQueues!.totalCount).toBe(0);
        expect(eventsOf(f.runtimeEvents, "queue_update").at(-1)).toMatchObject({
          pendingQueues: { totalCount: 0 },
        });
        await expect(f.api.pendingText(staleRead)).rejects.toMatchObject({
          status: 409,
        });
        const gif = Buffer.from(
          "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
          "base64",
        );
        const pending = await f.attachments.add({
          originalname: "pending.gif",
          mimetype: "image/gif",
          size: gif.length,
          buffer: gif,
        } as Express.Multer.File);
        await f.api.prompt({
          ...f.delivery(caption),
          behavior: mode,
          attachmentIds: [pending.id],
        });
        await f.api.prompt({
          ...f.delivery("later exact text"),
          behavior: mode,
        });
        const snapshot = await f.runtime.snapshot();
        expect(snapshot.runState).toBe("running");
        expect(snapshot.pendingQueues!.totalCount).toBe(2);
        const rows =
          mode === "steer"
            ? snapshot.pendingQueues!.steering
            : snapshot.pendingQueues!.followUp;
        expect(rows).toEqual([
          {
            id: `text-${mode}-0`,
            ...pendingTextSummary(caption),
            imageCount: 1,
            imageAttachmentIds: [pending.id],
          },
          {
            id: `text-${mode}-1`,
            textPreview: "later exact text",
            textLength: 16,
            textTruncated: false,
          },
        ]);
        const nativeQueue = eventsOf(f.piEvents, "queue_update").at(-1)!;
        expect(nativeQueue[mode === "steer" ? "steering" : "followUp"]).toEqual(
          caption
            ? [caption, "later exact text"]
            : ["", "", "later exact text"],
        );
        const read = {
          sessionId: f.sessionId,
          viewId: snapshot.active!.transcriptPage.viewId,
          revision: snapshot.pendingQueues!.revision,
        };
        expect(
          await f.api.pendingText({ ...read, itemId: rows[0]!.id }),
        ).toEqual({ text: caption });
        expect(
          await f.api.pendingText({ ...read, itemId: rows[1]!.id }),
        ).toEqual({ text: "later exact text" });
        expect(await f.api.pendingText(read)).toEqual({
          text: `1. ${caption}\n2. later exact text`,
        });
        const recovered = await f.api.recoverPending(f.sessionId);
        expect(recovered).toEqual({
          steering: mode === "steer" ? [caption, "later exact text"] : [],
          followUp: mode === "followUp" ? [caption, "later exact text"] : [],
          attachments: [pending],
          authorityId: f.application.authorityId,
        });
        expect((await f.api.attachmentPreview(pending.id)).size).toBe(
          gif.length,
        );
        await expect(f.api.attachmentPreview(image.id)).rejects.toMatchObject({
          status: 404,
        });
        const body = f.modelRequests[1]!.body;
        expect(JSON.stringify(body)).toContain("data:image/png;base64,");
        expect(JSON.stringify(body)).not.toContain("data:image/gif;base64,");
        expect((await f.runtime.snapshot()).pendingQueues!.totalCount).toBe(0);
        await f.api.abort(f.sessionId);
        expect(f.modelRequests).toHaveLength(2);
      } finally {
        releaseFirst?.();
        releaseLater?.();
      }
    },
    30_000,
  );

  it("keeps consumed image-only captions hidden after settlement and the next native queue update", async () => {
    const releases: Array<() => void> = [];
    const gates = Array.from(
      { length: 3 },
      () =>
        new Promise<void>((resolveGate) => {
          releases.push(resolveGate);
        }),
    );
    try {
      const f = await fixture(false, 0, (number) => gates[number - 1]!);
      await f.api.prompt(f.delivery("First synthetic task."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      );
      const add = (name: string) =>
        f.attachments.add({
          originalname: name,
          mimetype: "image/png",
          size: bytes.length,
          buffer: bytes,
        } as Express.Multer.File);
      const consumed = await add("consumed.png");
      await f.api.prompt({
        ...f.delivery(""),
        behavior: "steer",
        attachmentIds: [consumed.id],
      });
      releases[0]!();
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(2));
      releases[1]!();
      await settled(f, 1);
      expect((await f.runtime.snapshot()).pendingQueues!.totalCount).toBe(0);
      // No recovery or clear has removed Pi's stale native caption.
      expect(eventsOf(f.piEvents, "queue_update").at(-1)).toMatchObject({
        steering: [""],
        followUp: [],
      });
      await f.api.prompt(f.delivery("Second synthetic task."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(3));
      const pending = await add("pending.png");
      await f.api.prompt({
        ...f.delivery(""),
        behavior: "steer",
        attachmentIds: [pending.id],
      });
      expect(eventsOf(f.piEvents, "queue_update").at(-1)).toMatchObject({
        steering: ["", ""],
      });
      expect((await f.runtime.snapshot()).pendingQueues).toMatchObject({
        totalCount: 1,
        steering: [{ id: "text-steer-0", textPreview: "", imageCount: 1 }],
        followUp: [],
      });
      expect(await f.api.abort(f.sessionId)).toEqual({
        steering: [""],
        followUp: [],
        attachments: [pending],
        authorityId: f.application.authorityId,
      });
      await expect(f.api.attachmentPreview(consumed.id)).rejects.toMatchObject({
        status: 404,
      });
      expect((await f.api.attachmentPreview(pending.id)).size).toBe(
        bytes.length,
      );
      expect(f.modelRequests).toHaveLength(3);
      expect(f.workers).toHaveLength(1);
      expect(f.workers[0]!.stop).not.toHaveBeenCalled();
    } finally {
      for (const release of releases) release();
    }
  }, 30_000);

  it("recovers unchanged pending images while an extension delays message_start; get_messages does not expose that in-flight message", async () => {
    let releaseFirst!: () => void;
    let releaseLater!: () => void;
    const first = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const later = new Promise<void>((resolveGate) => {
      releaseLater = resolveGate;
    });
    try {
      const f = await fixture(false, 0, (number) =>
        number === 1 ? first : later,
      );
      await f.api.prompt(
        f.delivery("Keep delayed image event recovery active."),
      );
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      );
      const gif = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      );
      const consumed = await f.attachments.add({
        originalname: "starting.png",
        mimetype: "image/png",
        size: png.length,
        buffer: png,
      } as Express.Multer.File);
      await f.api.prompt({
        ...f.delivery("Delay unchanged image start."),
        behavior: "steer",
        attachmentIds: [consumed.id],
      });
      releaseFirst();
      await vi.waitFor(async () =>
        expect(
          (await f.runtime.snapshot()).pendingExtensionUiRequests,
        ).toHaveLength(1),
      );
      const dialog = (await f.runtime.snapshot())
        .pendingExtensionUiRequests![0]!;
      const publicMessages = await f.workers[0]!.request<{
        messages: unknown[];
      }>({ type: "get_messages" });
      expect(JSON.stringify(publicMessages.messages)).not.toContain(
        png.toString("base64"),
      );
      const pending = await f.attachments.add({
        originalname: "pending.gif",
        mimetype: "image/gif",
        size: gif.length,
        buffer: gif,
      } as Express.Multer.File);
      await f.api.prompt({
        ...f.delivery("Delay unchanged image start."),
        behavior: "followUp",
        attachmentIds: [pending.id],
      });
      expect(await f.api.recoverPending(f.sessionId)).toEqual({
        steering: [],
        followUp: ["Delay unchanged image start."],
        attachments: [pending],
        authorityId: f.application.authorityId,
      });
      await f.runtime.extensionUiResponse({
        sessionId: f.sessionId,
        id: dialog.id,
        confirmed: true,
      });
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(2));
      expect((await f.api.attachmentPreview(pending.id)).size).toBe(
        pending.size,
      );
      await expect(f.api.attachmentPreview(consumed.id)).rejects.toMatchObject({
        status: 404,
      });
      await f.api.abort(f.sessionId);
      expect((await f.api.attachmentPreview(pending.id)).size).toBe(
        pending.size,
      );
    } finally {
      releaseFirst?.();
      releaseLater?.();
    }
  }, 30_000);

  it("recovers original Inspire bytes across an invisible same-caption image replacement, but not after Pi consumes that input", async () => {
    let releaseFirst!: () => void;
    let releaseLater!: () => void;
    const first = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const later = new Promise<void>((resolveGate) => {
      releaseLater = resolveGate;
    });
    try {
      const f = await fixture(false, 0, (number) =>
        number === 1 ? first : later,
      );
      await f.api.prompt(f.delivery("Keep replacement recovery active."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      );
      const image = await f.attachments.add({
        originalname: "original.png",
        mimetype: "image/png",
        size: bytes.length,
        buffer: bytes,
      } as Express.Multer.File);
      await f.api.prompt({
        ...f.delivery("Replace pending image bytes."),
        behavior: "followUp",
        attachmentIds: [image.id],
      });
      expect(await f.api.recoverPending(f.sessionId)).toEqual({
        steering: [],
        followUp: ["Replace pending image bytes."],
        attachments: [image],
        authorityId: f.application.authorityId,
      });
      expect(
        Buffer.from(
          await (await f.api.attachmentPreview(image.id)).arrayBuffer(),
        ),
      ).toEqual(bytes);
      await f.api.prompt({
        ...f.delivery("Replace pending image bytes."),
        behavior: "followUp",
        attachmentIds: [image.id],
      });
      releaseFirst();
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(2));
      expect(JSON.stringify(f.modelRequests[1]!.body)).toContain(
        "data:image/gif;base64,",
      );
      const recovered = await f.api.recoverPending(f.sessionId);
      expect(recovered.attachments).toBeUndefined();
      expect(recovered.warning).toBeUndefined();
      await expect(f.api.attachmentPreview(image.id)).rejects.toMatchObject({
        status: 404,
      });
      await f.api.abort(f.sessionId);
    } finally {
      releaseFirst?.();
      releaseLater?.();
    }
  }, 30_000);
});

describe("native prompt admission and extension dialogs", () => {
  it("settles handled input without agent events or an immortal upload reference", async () => {
    const f = await fixture(false);
    const file = await f.attachments.add({
      originalname: "handled.txt",
      mimetype: "text/plain",
      size: 7,
      buffer: Buffer.from("payload"),
    } as Express.Multer.File);
    await expect(
      f.api.prompt({
        ...f.delivery("Handled without a model turn."),
        attachmentIds: [file.id],
      }),
    ).resolves.toMatchObject({ accepted: true });
    expect(f.modelRequests).toHaveLength(0);
    expect(eventsOf(f.piEvents, "agent_start")).toHaveLength(0);
    expect((await f.runtime.snapshot()).runState).toBe("idle");
    const path = join(
      await f.attachments.uploadDirectory(),
      `${file.id}-${file.fileName}`,
    );
    expect((await readFile(f.sessionFile, "utf8")).includes(path)).toBe(false);
    expect((await f.attachments.collectUnreferenced()).reclaimed).toEqual([
      path,
    ]);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      f.api.prompt(f.delivery("Continue with an ordinary prompt.")),
    ).resolves.toMatchObject({ accepted: true });
    await settled(f, 1);
    expect(f.modelRequests).toHaveLength(1);
  });

  it("holds follow-up behind a real Pi preflight auto-compaction and its original prompt", async () => {
    const f = await fixture(true, 1_000);
    const first = f.delivery("First prompt owns Pi's preflight.");
    const initial = f.api.prompt(first);
    await vi.waitFor(() =>
      expect(eventsOf(f.piEvents, "compaction_start")).toHaveLength(1),
    );
    expect(await f.workers[0]!.request({ type: "get_state" })).toMatchObject({
      isStreaming: false,
      isCompacting: true,
    });
    const follow = {
      ...f.delivery("Follow-up from compaction."),
      behavior: "followUp" as const,
    };
    const following = f.api.prompt(follow);
    await vi.waitFor(async () =>
      expect((await f.runtime.snapshot()).pendingQueues?.totalCount).toBe(1),
    );
    expect(f.modelRequests).toHaveLength(0);
    await expect(initial).resolves.toMatchObject({ accepted: true });
    await expect(following).resolves.toMatchObject({ accepted: true });
    await vi.waitFor(
      async () => {
        expect(f.modelRequests).toHaveLength(2);
        expect((await f.runtime.snapshot()).runState).toBe("idle");
      },
      { timeout: 10_000 },
    );
    const written = (await readFile(f.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as SessionEntry[];
    const userTexts = written.flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user") return [];
      const content = entry.message.content;
      return [
        typeof content === "string"
          ? content
          : content.find((part) => part.type === "text")?.text,
      ];
    });
    expect(userTexts.slice(-2)).toEqual([first.message, follow.message]);
    expect(eventsOf(f.runtimeEvents, "runtime_error")).toEqual([]);
  }, 20_000);

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
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(newMessages[1]!.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: first.message }],
    });
    expect(newMessages[3]!.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: second.message }],
    });
    expect(written.filter((entry) => entry.type === "compaction")).toHaveLength(
      1,
    );
    expect(
      written.findIndex((entry) => entry.type === "compaction"),
    ).toBeLessThan(written.indexOf(newMessages[1]!));
    const snapshot = await f.runtime.snapshot();
    expect(snapshot.active?.transcriptPage.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "system" })]),
    );
  }, 90_000);

  it("keeps an independent command's dialog answerable when the model settles", async () => {
    let releaseModel!: () => void;
    const modelReplyGate = new Promise<void>((resolveReply) => {
      releaseModel = resolveReply;
    });
    try {
      const f = await fixture(false, 0, modelReplyGate);
      await f.api.prompt(
        f.delivery("Reply after the command opens its dialog."),
      );
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      const command = f.api.prompt(f.delivery("/await"));
      void command.catch(() => {});
      await vi.waitFor(async () =>
        expect(
          (await f.runtime.snapshot()).pendingExtensionUiRequests,
        ).toHaveLength(1),
      );
      const dialog = (await f.runtime.snapshot())
        .pendingExtensionUiRequests![0]!;
      releaseModel();
      await settled(f, 1);
      expect(f.workers[0]!.hasPendingRequest("prompt")).toBe(true);
      expect((await f.runtime.snapshot()).pendingExtensionUiRequests).toEqual([
        dialog,
      ]);
      expect(eventsOf(f.runtimeEvents, "extension_ui_clear")).toEqual([]);
      await f.runtime.extensionUiResponse({
        sessionId: f.sessionId,
        id: dialog.id,
        confirmed: true,
      });
      await expect(command).resolves.toMatchObject({ accepted: true });
      expect((await f.runtime.snapshot()).pendingExtensionUiRequests).toEqual(
        [],
      );
      expect(f.workers).toHaveLength(1);
      expect(f.workers[0]!.stop).not.toHaveBeenCalled();
      expect(eventsOf(f.runtimeEvents, "runtime_error")).toEqual([]);
    } finally {
      releaseModel();
    }
  }, 20_000);

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
