import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiCommand } from "../shared/commands.js";
import {
  type ModelOption,
  type NewSessionDefaults,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../shared/contracts.js";
import { getAgentDir, piInstallation } from "./pi-runtime.js";
import { isolatedProcessOptions, signalProcessTree } from "./process-tree.mjs";

export interface ModelMetadata {
  models: ModelOption[];
  commands?: PiCommand[];
  defaults: NewSessionDefaults;
  /** Registered definitions, including routers whose physical provider lacks auth. */
  virtualModels: ModelOption[];
  enabledModelPatterns?: string[];
  warning?: string;
}

interface NativeModelSettingsRead {
  effective: Record<string, unknown>;
  projectOverrides: string[];
  globalError: boolean;
  projectError: boolean;
}

async function queryModelWorker<Result>(
  cwd: string,
  agentDir: string,
  args: string[],
  accept: (result: unknown) => result is Result,
  processCwd = cwd,
): Promise<Result> {
  const ownPath = fileURLToPath(import.meta.url);
  const source = ownPath.endsWith(".ts");
  const child = fork(
    join(dirname(ownPath), `model-metadata-worker.${source ? "ts" : "js"}`),
    [cwd, ...args],
    {
      cwd: processCwd,
      execArgv: source ? ["--import", import.meta.resolve("tsx")] : [],
      env: {
        ...process.env,
        INSPIRE_PI_COMMAND: piInstallation.commandPath,
        PI_CODING_AGENT_DIR: agentDir,
        PI_SKIP_VERSION_CHECK: "1",
      },
      ...isolatedProcessOptions(),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  return new Promise((resolve, reject) => {
    let result: Result | undefined;
    let timedOut = false;
    let retirement: Promise<void> | undefined;
    const retire = () =>
      (retirement ??= signalProcessTree(child, "SIGKILL", { isolated: true }));
    const timer = setTimeout(() => {
      timedOut = true;
      void retire();
    }, 15_000);
    child.on("message", (message: { ok?: boolean; result?: unknown }) => {
      if (message.ok && accept(message.result)) result = message.result;
      if (typeof message.ok === "boolean") void retire();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", async () => {
      clearTimeout(timer);
      await retire();
      if (!timedOut && result !== undefined) resolve(result);
      else
        reject(
          new Error(
            timedOut
              ? "Pi model discovery timed out"
              : "Pi model extensions could not load",
          ),
        );
    });
  });
}

export async function queryModelMetadata(cwd: string): Promise<ModelMetadata> {
  return queryModelWorker(
    cwd,
    getAgentDir(),
    ["catalog"],
    (result): result is ModelMetadata => {
      const metadata = result as Partial<ModelMetadata> | null | undefined;
      return (
        metadata?.defaults?.cwd === cwd &&
        Array.isArray(metadata.models) &&
        Array.isArray(metadata.virtualModels)
      );
    },
  );
}

export function readNativeModelSettings(
  cwd: string,
  agentDir: string,
): Promise<NativeModelSettingsRead> {
  return queryModelWorker(
    cwd,
    agentDir,
    ["settings"],
    (result): result is NativeModelSettingsRead => {
      const settings = result as
        | Partial<NativeModelSettingsRead>
        | null
        | undefined;
      return Boolean(
        settings?.effective && Array.isArray(settings.projectOverrides),
      );
    },
    process.cwd(),
  );
}

export function queryModelThinkingLevel(
  cwd: string,
  provider: string,
  modelId: string,
  current: ThinkingLevel,
): Promise<ThinkingLevel> {
  return queryModelWorker(
    cwd,
    getAgentDir(),
    ["thinking", provider, modelId, current],
    (result): result is ThinkingLevel =>
      THINKING_LEVELS.includes(result as ThinkingLevel),
    process.cwd(),
  );
}

/** Validate a candidate with the same native resources and trust as discovery. */
export async function validateModelConfig(
  cwd: string,
  agentDir: string,
  path: string,
): Promise<void> {
  await queryModelWorker(
    cwd,
    agentDir,
    ["validate", path],
    (result): result is null => result === null,
  );
}

/** Catalog and default previews share one native query per actual target cwd.
 * Explicit refresh/config/auth changes retire all completed snapshots; concurrent
 * readers of the same target share its in-flight query. */
export class ModelMetadataCatalog {
  private readonly cached = new Map<string, ModelMetadata>();
  private readonly pending = new Map<string, Promise<ModelMetadata>>();
  private generation = 0;

  constructor(private readonly query = queryModelMetadata) {}

  get revision(): number {
    return this.generation;
  }

  peek(cwd: string): ModelMetadata | undefined {
    return this.cached.get(cwd);
  }

  invalidate(): void {
    this.generation += 1;
    this.cached.clear();
    this.pending.clear();
  }

  read(cwd: string, refresh = false): Promise<ModelMetadata> {
    const pending = this.pending.get(cwd);
    if (pending) return pending;
    if (refresh) this.invalidate();
    const cached = this.cached.get(cwd);
    if (cached) {
      this.cached.delete(cwd);
      this.cached.set(cwd, cached);
      return Promise.resolve(cached);
    }
    const generation = this.generation;
    const operation = this.query(cwd)
      .then((result) => {
        if (generation === this.generation) {
          this.cached.set(cwd, result);
          if (this.cached.size > 16)
            this.cached.delete(this.cached.keys().next().value!);
        }
        return result;
      })
      .finally(() => {
        if (this.pending.get(cwd) === operation) this.pending.delete(cwd);
      });
    this.pending.set(cwd, operation);
    return operation;
  }
}
