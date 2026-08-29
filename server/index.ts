import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAccessTokenPath, resolveAccessToken } from "./access-token.js";
import { createInspireServer } from "./app.js";
import { AttachmentStore } from "./attachments.js";
import { openBrowser } from "./browser-opener.js";
import {
  defaultDiagnosticLogPath,
  nullDiagnosticLogger,
  openDiagnosticLogger,
} from "./diagnostics.js";
import { GitInspectionService } from "./git-inspection.js";
import {
  consumeStopRequest,
  INSTANCE_STATE_VERSION,
  type InstanceState,
  instanceUrl,
  processStartIdentity,
  removeInstanceState,
  writeInstanceState,
} from "./instance-state.mjs";
import {
  inspectInspireSource,
  MaintenanceRestartController,
} from "./maintenance-restart.js";
import {
  MOCK_AVAILABLE_MODELS,
  MockCatalog,
  MockGitInspection,
  MockRuntime,
} from "./mock.js";
import {
  availableModelOptions,
  resolveNewSessionDefaults,
} from "./model-catalog.js";
import {
  DefaultPackageManager,
  getAgentDir,
  ModelRuntime,
  piInstallation,
  SettingsManager,
} from "./pi-runtime.js";
import { PiUpdateChecker } from "./pi-update-checker.js";
import { PreferencesStore } from "./preferences.js";
import { ResourceStore } from "./resources.js";
import { RuntimeController, type RuntimeLike } from "./runtime.js";
import { SessionCatalog, type SessionCatalogLike } from "./session-catalog.js";
import {
  defaultToolPresentationConfigPath,
  ToolPresentationConfigStore,
} from "./tool-presentation-config.js";
import { GitHubReleaseUpdateChecker } from "./update-checker.js";
import {
  defaultUpdateStatePath,
  UpdateCoordinator,
} from "./update-coordinator.js";

const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const inferredRoot = await readFile(
  join(moduleRoot, "package.json"),
  "utf8",
).then(
  () => moduleRoot,
  () => join(moduleRoot, ".."),
);
const root = resolve(process.env.INSPIRE_INSTALLATION_ROOT || inferredRoot);
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
) as {
  version: string;
  repository?: string | { url?: string };
};

const host = process.env.INSPIRE_HOST ?? "127.0.0.1";
if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
  throw new Error("Inspire binds to loopback only in the local release");
}
const port = Number.parseInt(process.env.INSPIRE_PORT ?? "4587", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535)
  throw new Error("INSPIRE_PORT must be a valid TCP port");
const tokenPath =
  process.env.INSPIRE_TOKEN_PATH || defaultAccessTokenPath(root, host, port);
const token = await resolveAccessToken(process.env.INSPIRE_TOKEN, tokenPath);
const mock = process.env.INSPIRE_MOCK === "1";
const repositoryUrl =
  typeof packageJson.repository === "string"
    ? packageJson.repository
    : packageJson.repository?.url;
const updateChecker = mock
  ? undefined
  : new GitHubReleaseUpdateChecker({
      currentVersion: packageJson.version,
      repositoryUrl,
    });
const piUpdateChecker = mock
  ? undefined
  : new PiUpdateChecker({
      currentVersion: piInstallation.version,
      checkExtensions: async () => {
        const agentDir = getAgentDir();
        const settingsManager = SettingsManager.create(root, agentDir, {
          projectTrusted: false,
        });
        if (settingsManager.drainErrors().length > 0)
          throw new Error("Pi settings are unavailable");
        return new DefaultPackageManager({
          cwd: root,
          agentDir,
          settingsManager,
        }).checkForAvailableUpdates();
      },
    });
const runningSource = mock
  ? { kind: "package" as const, version: packageJson.version }
  : await inspectInspireSource(root);
const configuredMockStreamInterval = mock
  ? process.env.INSPIRE_MOCK_STREAM_INTERVAL_MS
  : undefined;
const mockStreamIntervalMs = configuredMockStreamInterval
  ? Number(configuredMockStreamInterval)
  : undefined;
if (
  mockStreamIntervalMs !== undefined &&
  (!Number.isInteger(mockStreamIntervalMs) ||
    mockStreamIntervalMs < 10 ||
    mockStreamIntervalMs > 1_000)
) {
  throw new Error(
    "INSPIRE_MOCK_STREAM_INTERVAL_MS must be an integer from 10 to 1000",
  );
}
const configuredLogPath = process.env.INSPIRE_LOG_PATH;
const diagnosticLogPath =
  configuredLogPath || defaultDiagnosticLogPath(root, host, port);
const diagnostics = await openDiagnosticLogger({
  path: diagnosticLogPath,
  createPrivateDirectory: !configuredLogPath,
  base: {
    processId: process.pid,
    version: packageJson.version,
    piVersion: piInstallation.version,
    mock,
    host,
    port,
  },
}).catch((error) => {
  console.error(
    "Unable to initialize private diagnostic logging",
    error instanceof Error ? error.message : String(error),
  );
  return nullDiagnosticLogger();
});
diagnostics.record("info", "host_starting", { processId: process.pid });

const attachments = new AttachmentStore();
let catalog: SessionCatalogLike;
let runtime: RuntimeLike;
if (mock) {
  catalog = new MockCatalog();
  runtime = new MockRuntime({ streamIntervalMs: mockStreamIntervalMs });
} else {
  catalog = new SessionCatalog(process.cwd());
  runtime = new RuntimeController(
    catalog,
    attachments,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    diagnostics,
  );
}
const preferences = new PreferencesStore(
  process.env.INSPIRE_PREFERENCES_PATH || undefined,
);
const toolPresentations = new ToolPresentationConfigStore(
  process.env.INSPIRE_TOOL_PRESENTATIONS_PATH ||
    defaultToolPresentationConfigPath(root),
);
const resources = new ResourceStore();
const git = mock ? new MockGitInspection() : new GitInspectionService();
const modelRuntime = mock
  ? null
  : await ModelRuntime.create().catch((error) => {
      console.error(
        "Unable to load Pi's model catalog for the new-session picker:",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    });
const readAvailableModels = async () => {
  if (mock) return structuredClone(MOCK_AVAILABLE_MODELS);
  if (!modelRuntime) return [];
  try {
    return await availableModelOptions(modelRuntime);
  } catch (error) {
    console.error(
      "Unable to refresh Pi's available models:",
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
};
const readNewSessionDefaults = async (cwd: string) => {
  if (mock) {
    return {
      cwd,
      model: structuredClone(MOCK_AVAILABLE_MODELS[0] ?? null),
      thinkingLevel: "medium" as const,
    };
  }
  if (!modelRuntime)
    throw Object.assign(new Error("Pi's model catalog is unavailable"), {
      status: 503,
    });
  return resolveNewSessionDefaults(modelRuntime, cwd);
};
const maintenanceRestart = mock
  ? undefined
  : new MaintenanceRestartController({
      runtime,
      root,
      piVersion: piInstallation.version,
      runningSource,
      diagnostics,
    });
const updateCoordinator = new UpdateCoordinator({
  currentPiVersion: piInstallation.version,
  inspireChecker: updateChecker,
  piChecker: piUpdateChecker,
  statePath: mock ? undefined : defaultUpdateStatePath(root, host, port),
  diagnostics,
});

const application = createInspireServer({
  token,
  runtime,
  catalog,
  attachments,
  preferences,
  toolPresentations,
  resources,
  git,
  mock,
  version: packageJson.version,
  piVersion: piInstallation.version,
  maintenanceRestart,
  updateCoordinator,
  availableModels: readAvailableModels,
  newSessionDefaults: readNewSessionDefaults,
  distDir: join(root, "dist"),
  shutdown: () => shutdown("authenticated host shutdown"),
});

const statePath = process.env.INSPIRE_STATE_PATH;
const stopRequestPath = process.env.INSPIRE_STOP_REQUEST_PATH;
let statePublication: Promise<void> | null = null;
let publishedState: InstanceState | null = null;
let shuttingDown = false;

async function shutdown(reason: string, requestedExitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  let exitCode = requestedExitCode;
  console.log(`Shutting down after ${reason}…`);
  diagnostics.record("info", "host_stopping", { reason, requestedExitCode });
  try {
    await application.close();
    if (statePublication) await statePublication;
  } catch (error) {
    console.error("Failed to shut down cleanly", error);
    exitCode = 1;
  } finally {
    try {
      await diagnostics.close();
    } catch (error) {
      console.error("Failed to close diagnostic logging", error);
      exitCode = 1;
    }
    try {
      if (statePath && publishedState)
        await removeInstanceState(statePath, publishedState);
    } catch (error) {
      console.error("Failed to remove the Inspire instance state", error);
      exitCode = 1;
    } finally {
      process.exit(exitCode);
    }
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

application.server.once("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${host}:${port} is already in use. Inspire will not stop an unknown process.`,
    );
  } else {
    console.error("Unable to start the Inspire host", error);
  }
  void shutdown("startup failure", 1);
});

async function announceStarted(): Promise<void> {
  if (stopRequestPath && (await consumeStopRequest(stopRequestPath))) {
    await shutdown("a pending stop request");
    return;
  }
  const instanceState: InstanceState = {
    schemaVersion: INSTANCE_STATE_VERSION,
    pid: process.pid,
    root,
    host,
    port,
    token,
    startedAt: new Date().toISOString(),
    processStartTime: await processStartIdentity(process.pid),
    mock,
  };
  if (statePath) {
    publishedState = instanceState;
    statePublication = writeInstanceState(statePath, instanceState);
    try {
      await statePublication;
    } catch (error) {
      console.error("Unable to publish the Inspire instance state", error);
      await shutdown("instance-state failure", 1);
      return;
    }
  }
  if (shuttingDown) return;
  diagnostics.record("info", "host_ready", { processId: process.pid });
  const url = instanceUrl(instanceState);
  if (process.env.INSPIRE_QUIET !== "1") {
    console.log(`\n  INSΠRE ${packageJson.version}${mock ? " (mock)" : ""}`);
    console.log(`  ${url}\n`);
  }
  if (process.env.INSPIRE_OPEN === "1") {
    openBrowser(url, (error) => {
      diagnostics.record("warning", "browser_open_failed", {
        errorName: error.name,
        errorCode: (error as NodeJS.ErrnoException).code,
      });
      console.error(`Could not open a browser automatically: ${error.message}`);
    });
  }
}

if (stopRequestPath && (await consumeStopRequest(stopRequestPath))) {
  await shutdown("a pending stop request");
} else {
  application.server.listen(port, host, () => void announceStarted());
}
process.on("unhandledRejection", (error) => {
  diagnostics.record("error", "unhandled_rejection", {
    errorName: error instanceof Error ? error.name : typeof error,
  });
  console.error("Unhandled rejection", error);
});
