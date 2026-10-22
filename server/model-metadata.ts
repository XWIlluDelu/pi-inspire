import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelOption, NewSessionDefaults } from "../shared/contracts.js";
import { getAgentDir, piInstallation } from "./pi-runtime.js";
import { isolatedProcessOptions, signalProcessTree } from "./process-tree.mjs";

export interface ModelMetadata {
  models: ModelOption[];
  defaults: NewSessionDefaults;
  /** Registered definitions, including routers whose physical provider lacks auth. */
  virtualModels: ModelOption[];
  warning?: string;
}

async function queryModelWorker(
  cwd: string,
  agentDir: string,
  validationPath?: string,
): Promise<ModelMetadata | null> {
  const ownPath = fileURLToPath(import.meta.url);
  const source = ownPath.endsWith(".ts");
  const child = fork(
    join(dirname(ownPath), `model-metadata-worker.${source ? "ts" : "js"}`),
    [cwd, ...(validationPath ? [validationPath] : [])],
    {
      cwd,
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
    let result: ModelMetadata | null | undefined;
    let timedOut = false;
    let retirement: Promise<void> | undefined;
    const retire = () =>
      (retirement ??= signalProcessTree(child, "SIGKILL", { isolated: true }));
    const timer = setTimeout(() => {
      timedOut = true;
      void retire();
    }, 15_000);
    child.on(
      "message",
      (message: { ok?: boolean; result?: ModelMetadata | null }) => {
        if (message.ok) result = message.result;
        if (typeof message.ok === "boolean") void retire();
      },
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", async () => {
      clearTimeout(timer);
      await retire();
      if (
        !timedOut &&
        (validationPath
          ? result === null
          : result &&
            result.defaults.cwd === cwd &&
            Array.isArray(result.models) &&
            Array.isArray(result.virtualModels))
      )
        resolve(result ?? null);
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
  return (await queryModelWorker(cwd, getAgentDir())) as ModelMetadata;
}

/** Validate a candidate with the same native resources and trust as discovery. */
export async function validateModelConfig(
  cwd: string,
  agentDir: string,
  path: string,
): Promise<void> {
  await queryModelWorker(cwd, agentDir, path);
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
