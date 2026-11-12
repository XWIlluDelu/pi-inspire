import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
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
import type { SessionRecord } from "../../../server/session-catalog.js";
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

import { nativePiWorkspace, stubNativePiEnvironment } from "./native-pi.js";
import {
  listenOnLoopback,
  startOfflineModel,
  writeOfflineModels,
} from "./offline-model.js";
import { catalog as sessionCatalog } from "./runtime.js";

// These tests run the browser API against a native Host without browser storage.
vi.mock("../../../src/browser-auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  authenticatedFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  socketTicket: async () => "fixture-socket-ticket",
}));

const PROVIDER = "pi-operation-offline";
const MODEL = "tiny-context-fixture";
const TOKEN = "pi-operation-synthetic-local-token";
const cleanups: Array<() => Promise<void>> = [];

type ObservedEvent = Record<string, unknown> & { type: string };
interface Observation {
  method: string;
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

export async function fixture(
  autoCompaction: boolean,
  compactionDelayMs = 0,
  modelReplyGate?: Promise<void> | ((requestNumber: number) => Promise<void>),
) {
  const {
    root: directory,
    agent: config,
    cwd: workspace,
    sessions,
    env,
  } = await nativePiWorkspace("inspire-pi-operation-", {
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
  });
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const environment = {
    ...env,
    PI_FIXTURE_COMPACT_DELAY_MS: String(compactionDelayMs),
  };
  // SDK reads in the Host and subprocesses use the same isolated Pi config.
  stubNativePiEnvironment(environment);
  const model = await startOfflineModel({
    reply: (number) => `Synthetic reply ${number}.`,
    beforeReply: (number) =>
      typeof modelReplyGate === "function"
        ? modelReplyGate(number)
        : modelReplyGate,
    usage: { prompt_tokens: 64, completion_tokens: 8, total_tokens: 72 },
  });
  cleanups.push(() => model.close());
  await writeOfflineModels(config, model.baseUrl, PROVIDER, [
    {
      id: MODEL,
      name: "Synthetic tiny context",
      input: ["text", "image"],
      contextWindow: 2048,
    },
  ]);

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
  };
  const catalog = sessionCatalog([record]);
  const attachments = new AttachmentStore(join(directory, "uploads"));
  const workers: PiRpcProcess[] = [];
  const piEvents: ObservedEvent[] = [];
  const runtimeEvents: ObservedEvent[] = [];
  const runtime = new RuntimeController(catalog, attachments, {
    createProcess: (options) => {
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
        env: { ...environment, ...options.env },
      });
      vi.spyOn(worker, "stop"); // Observe, never replace, real process teardown.
      worker.on("event", (event) => piEvents.push(event));
      workers.push(worker);
      return worker;
    },
  });
  runtime.on("event", (event) => runtimeEvents.push(event));
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
    version: "0.0.0-fixture",
    piVersion: piInstallation.version,
    distDir: join(directory, "missing-dist"),
    // A short observation window exercises HTTP receipt polling for dialogs.
    ...(autoCompaction ? {} : { promptObservationWindowMs: 100 }),
    // No terminal, update checkers, global models, or real service adapters.
  });
  cleanups.push(() => application.close());
  const baseUrl = await listenOnLoopback(application.server);
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
    const observation: Observation = { method: init?.method ?? "GET" };
    observations.push(observation);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${TOKEN}`);
    const response = await nativeFetch(url, { ...init, headers });
    if (response.headers.get("Content-Type")?.includes("application/json"))
      observation.receipt = (await response
        .clone()
        .json()) as PromptDeliveryResponse;
    return response;
  }) satisfies typeof fetch);
  // The server tsconfig intentionally excludes browser sources. A computed
  // import lets Vitest execute the actual client without adding its DOM build
  // graph to the server composite project; the narrow test interface is typed.
  const browserModulePath = resolve("src/api.ts");
  const { createApi } = (await import(browserModulePath)) as {
    createApi(): BrowserClient;
  };
  const client = createApi();
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
  return {
    runtime,
    attachments,
    application,
    api,
    workers,
    piEvents,
    runtimeEvents,
    modelRequests: model.requests,
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
