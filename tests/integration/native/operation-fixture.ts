import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, vi } from "vitest";
import { PiRpcProcess } from "../../../server/pi-rpc";
import { piInstallation, SessionManager } from "../../../server/pi-runtime";
import type { PromptDeliveryRequest } from "../../../shared/contracts";
import type { PendingOperationIdentity } from "../../../shared/host-operations";
import { type Api, createApi } from "../../../src/api";
import { savedAssistant } from "../../fixtures/history-session";
import { hostServices } from "../../fixtures/host-services";
import {
  closeHostApiFixture,
  hostApiFixture,
} from "../../server/fixtures/host-api";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "../../server/fixtures/native-pi";
import {
  startOfflineModel,
  writeOfflineModels,
} from "../../server/fixtures/offline-model";

const PROVIDER = "pi-operation-offline";
const MODEL = "tiny-context-fixture";
const cleanups: Array<() => Promise<void>> = [];

type ObservedEvent = Record<string, unknown> & { type: string };
type NativeOperationApi = Pick<
  Api,
  "attachmentPreview" | "json" | "pendingOperation" | "prompt"
> &
  Record<
    "recoverPending" | "abort",
    (
      id: string,
      identity?: PendingOperationIdentity,
    ) => ReturnType<Api["pendingOperation"]>
  >;

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

  const session = SessionManager.create(workspace, sessions);
  session.appendModelChange(PROVIDER, MODEL);
  session.appendThinkingLevelChange("off");
  const seedUsage = {
    ...savedAssistant("").usage,
    // Above the 2048 - 512 compaction threshold, below overflow.
    input: 1792,
    output: 8,
    totalTokens: 1800,
  };
  const seedIds = Array.from({ length: 8 }, (_, index) => {
    const text = `Synthetic seed ${index}. `.repeat(30);
    const timestamp = Date.parse("2026-01-01T00:00:00.000Z") + index;
    return session.appendMessage(
      index % 2
        ? savedAssistant(text, {
            provider: PROVIDER,
            model: MODEL,
            timestamp,
            usage: seedUsage,
          })
        : { role: "user", content: text, timestamp },
    );
  });
  const sessionId = session.getSessionId();
  const sessionFile = session.getSessionFile()!;
  const workers: PiRpcProcess[] = [];
  const piEvents: ObservedEvent[] = [];
  const runtimeEvents: ObservedEvent[] = [];
  const services = hostServices(directory, {
    cwd: workspace,
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
          "--extension",
          resolve("docs/examples/native-ui.ts"),
        ],
        env: { ...environment, ...options.env },
      });
      vi.spyOn(worker, "stop"); // Observe, never replace, real process teardown.
      worker.on("event", (event) => piEvents.push(event));
      workers.push(worker);
      return worker;
    },
  });
  const { runtime, attachments } = services;
  runtime.on("event", (event) => runtimeEvents.push(event));
  const host = await hostApiFixture({
    services: { cwd: workspace, ...services },
    piVersion: piInstallation.version,
    // Exercise polling while native dialogs are open.
    ...(autoCompaction ? {} : { promptObservationWindowMs: 100 }),
  });
  cleanups.push(() => closeHostApiFixture(host));
  vi.stubGlobal("fetch", host.fetchHost);
  const client = createApi();
  const api: NativeOperationApi = {
    ...client,
    recoverPending: (id, identity = host.promptDelivery({})) =>
      client.pendingOperation(
        { ...identity, sessionId: id, action: "recover" },
        "start",
      ),
    abort: (id, identity = host.promptDelivery({})) =>
      client.pendingOperation(
        { ...identity, sessionId: id, action: "abort" },
        "start",
      ),
  };
  await runtime.openSession(sessionId);
  await runtime.setRuntimeSetting(sessionId, {
    key: "steeringMode",
    value: "one-at-a-time",
  });
  await vi.waitFor(
    async () => {
      const snapshot = await runtime.snapshot(sessionId);
      expect(snapshot.active?.commands).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "await" })]),
      );
      expect(snapshot.active?.projectionConflict).toBeNull();
    },
    { timeout: 10_000 },
  );
  expect(piInstallation.commandPath).toBe(process.env.INSPIRE_PI_COMMAND);
  expect(workers).toHaveLength(1);
  const initial = await runtime.snapshot(sessionId);
  expect(initial.active?.availableModels).toEqual([
    expect.objectContaining({ provider: PROVIDER, id: MODEL }),
  ]);
  return {
    runtime,
    attachments,
    application: host.application,
    api,
    workers,
    piEvents,
    runtimeEvents,
    modelRequests: model.requests,
    sessionFile,
    earlierEntryId: seedIds[5]!,
    sessionId,
    directory,
    workspace,
    delivery(message: string): PromptDeliveryRequest {
      return host.promptDelivery({ sessionId, message });
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
      const snapshot = await f.runtime.snapshot(f.sessionId);
      expect(snapshot.sessionStatuses[f.sessionId]?.runState).toBe("idle");
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
