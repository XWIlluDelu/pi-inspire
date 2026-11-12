import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAccessTokenPath, resolveAccessToken } from "./access-token.js";
import { createInspireServer } from "./app.js";
import {
  AttachControlConnection,
  AttachControlRegistry,
  takeoverCandidate,
} from "./attach-control.js";
import { AttachmentStore } from "./attachments.js";
import { openBrowser } from "./browser-opener.js";
import {
  defaultDiagnosticLogPath,
  nullDiagnosticLogger,
  openDiagnosticLogger,
} from "./diagnostics.js";
import { GitInspectionService } from "./git-inspection.js";
import {
  defaultHerdrWorkerDirectory,
  HerdrEnhancement,
} from "./herdr-enhancement.js";
import { HerdrWorkerRegistry } from "./herdr-worker-registry.js";
import { HostRestartController } from "./host-restart.js";
import { hostRestartBackend } from "./host-restart-backend.js";
import {
  completeInstanceShutdown,
  consumeStopRequest,
  INSTANCE_STATE_VERSION,
  type InstanceState,
  instanceUrl,
  processStartIdentity,
  refuseInstanceShutdown,
  removeInstanceState,
  watchInstanceShutdown,
  writeInstanceState,
} from "./instance-state.mjs";
import { HOST_RESTART_EXIT_CODE } from "./launcher-restart.mjs";
import {
  inspectInspireSource,
  MaintenanceRestartController,
} from "./maintenance-restart.js";
import { McpConfigService } from "./mcp-config.js";
import { ModelMetadataCatalog } from "./model-metadata.js";
import { ModelSettingsService } from "./model-settings.js";
import { resolvePiInstallationIdentity } from "./pi-installation.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import {
  DefaultPackageManager,
  getAgentDir,
  ModelRuntime,
  piInstallation,
  SettingsManager,
} from "./pi-runtime.js";
import { PiSessionActivity } from "./pi-session-activity.js";
import { PiUpdateChecker } from "./pi-update-checker.js";
import { PreferencesStore } from "./preferences.js";
import {
  nativeOAuthDescriptors,
  ProviderAuthService,
} from "./provider-auth.js";
import { ResourceStore } from "./resources.js";
import { RuntimeController, type RuntimeWorkerStatus } from "./runtime.js";
import { createHostSessionCatalog } from "./session-catalog.js";
import {
  currentStaticAssetPaths,
  defaultStaticAssetCacheDirectory,
  prepareStaticAssetCache,
} from "./static-asset-cache.mjs";
import {
  connectExistingTerminalDaemon,
  launchTerminalDaemon,
} from "./terminal-daemon-launcher.js";
import {
  LazyTerminalService,
  type TerminalService,
} from "./terminal-service.js";
import { TerminalSessionManager } from "./terminal-session-manager.js";
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
const repositoryUrl =
  typeof packageJson.repository === "string"
    ? packageJson.repository
    : packageJson.repository?.url;
const updateChecker = new GitHubReleaseUpdateChecker({
  currentVersion: packageJson.version,
  repositoryUrl,
});
const piUpdateChecker = new PiUpdateChecker({
  currentVersion: piInstallation.version,
  readInstalledVersion: async () =>
    (await resolvePiInstallationIdentity({ installationRoot: root })).version,
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
const runningSource = await inspectInspireSource(root);
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

const preferences = new PreferencesStore(
  process.env.INSPIRE_PREFERENCES_PATH || undefined,
);
const herdr = new HerdrEnhancement({
  enabled: (await preferences.read()).herdrEnabled,
  registry: new HerdrWorkerRegistry(
    defaultHerdrWorkerDirectory(root, host, port),
  ),
  diagnostics,
});
void herdr.initialize();
const attachments = new AttachmentStore();
const catalog = createHostSessionCatalog(process.cwd(), preferences);
const modelMetadata = new ModelMetadataCatalog();
// The Host's own workers carry their worker tag; while it owns them they are
// not other Pi instances. After a Host-only restart nobody owns those tags.
const attachControl: AttachControlRegistry = new AttachControlRegistry(
  undefined,
  (record): boolean =>
    record.tag !== undefined && runtime.ownWorkerTags().has(record.tag),
);
const runtime: RuntimeController = new RuntimeController(catalog, attachments, {
  createProcess: (options) => herdr.createProcess(options),
  diagnostics,
})
  .setModelMetadataCatalog(modelMetadata)
  .setExternalSessionConnector(
    async (sessionId, sessionFile, match, idleOnly) => {
      const instance = takeoverCandidate(
        await attachControl.forSession(sessionId, sessionFile, {
          includeStale: idleOnly,
        }),
        match,
        idleOnly,
      );
      return instance
        ? new AttachControlConnection(attachControl, instance)
        : null;
    },
  )
  .setExternalSessionTerminator((sessionId, sessionFile) =>
    attachControl.stopSession(sessionId, sessionFile),
  )
  .setExternalSessionPresence((sessionId, sessionFile, fresh, isAncestor) =>
    attachControl.branchLeaves(sessionId, sessionFile, {
      observe: !fresh,
      isAncestor,
    }),
  )
  .on("worker_status", (rpc: PiRpcProcess, status: RuntimeWorkerStatus) => {
    herdr.updateWorkerStatus(rpc, status);
  });
const sessionActivity = new PiSessionActivity({
  catalog,
  registry: attachControl,
  publish: (activities) => {
    runtime.emit("event", {
      type: "external_session_activity",
      activities,
    });
  },
});
sessionActivity.start();
const toolPresentations = new ToolPresentationConfigStore(
  process.env.INSPIRE_TOOL_PRESENTATIONS_PATH ||
    defaultToolPresentationConfigPath(root),
);
const resources = new ResourceStore();
const git = new GitInspectionService();
let terminal: TerminalService;
if (process.env.INSPIRE_TERMINAL_IN_PROCESS === "1") {
  terminal = new TerminalSessionManager();
} else {
  terminal = await launchTerminalDaemon({ root, host, port }).catch((error) => {
    const message =
      error instanceof Error ? error.message : "Terminal service unavailable";
    diagnostics.record("warning", "terminal_daemon_unavailable", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    console.error(`Terminal service unavailable: ${message}`);
    return new LazyTerminalService(() =>
      connectExistingTerminalDaemon({ root, host, port }),
    );
  });
}
const modelRuntime = await ModelRuntime.create({
  refreshOnCreate: false,
}).catch((error) => {
  console.error(
    "Unable to initialize Pi provider authentication:",
    error instanceof Error ? error.message : String(error),
  );
  return null;
});
const maintenanceRestart = new MaintenanceRestartController({
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
  statePath: defaultUpdateStatePath(root, host, port),
  diagnostics,
});
const distDir = join(root, "dist");
let staticAssetCacheDirs: string[] = [];
{
  const cacheDirectory = defaultStaticAssetCacheDirectory(root);
  try {
    const cache = await prepareStaticAssetCache(
      join(distDir, "assets"),
      cacheDirectory,
      { assetPaths: await currentStaticAssetPaths(distDir) },
    );
    staticAssetCacheDirs = cache.generationDirectories;
    if (cache.pruneFailures > 0)
      console.warn(
        `Deferred cleanup of ${cache.pruneFailures} cached asset generation(s).`,
      );
  } catch (error) {
    console.error(
      "Unable to preserve prior static assets:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

const application = createInspireServer({
  token,
  instanceState: () => (shuttingDown ? null : publishedState),
  runtime,
  catalog,
  attachments,
  preferences,
  toolPresentations,
  resources,
  git,
  terminal,
  version: packageJson.version,
  piVersion: piInstallation.version,
  getHerdrStatus: () => herdr.status(),
  maintenanceRestart,
  hostRestart: new HostRestartController(
    runtime,
    hostRestartBackend(root, {
      enabled: true,
      systemdEnabled: host === "127.0.0.1" && port === 4587,
      restart: () =>
        shutdown("launcher-owned Host restart", HOST_RESTART_EXIT_CODE),
    }),
    () => !herdr.needsOwnershipRelease,
  ),
  updateCoordinator,
  bootstrapModels: () => modelMetadata.peek(process.cwd())?.models ?? [],
  invalidateModels: () => modelMetadata.invalidate(),
  modelMetadata: (cwd: string, refresh?: boolean) =>
    modelMetadata.read(cwd, refresh),
  modelSettings: new ModelSettingsService(),
  mcpConfig: new McpConfigService(),
  providerAuth: modelRuntime
    ? new ProviderAuthService(
        modelRuntime,
        () => SettingsManager.create(root, getAgentDir()).getOrCreateDeviceId(),
        undefined,
        await nativeOAuthDescriptors(piInstallation.sdkEntryPath),
      )
    : undefined,
  distDir,
  staticAssetCacheDirs,
  shutdown: () => shutdown("authenticated host shutdown"),
});

const statePath = process.env.INSPIRE_STATE_PATH;
const stopRequestPath = process.env.INSPIRE_STOP_REQUEST_PATH;
let statePublication: Promise<void> | null = null;
let publishedState: InstanceState | null = null;
let shuttingDown = false;
let closeShutdownControl: (() => void) | undefined;
let scopedShutdownPreparation: Promise<boolean> | null = null;

async function prepareScopedHerdrShutdown(): Promise<boolean> {
  let leaseId: string | undefined;
  try {
    const reservation = runtime.reserveMaintenanceRestart(false, false, true);
    if (reservation.kind !== "ready") throw new Error(reservation.reason);
    leaseId = reservation.leaseId;
    if (runtime.commitMaintenanceRestart(leaseId).kind !== "committed")
      throw new Error("The Host could not reserve ownership release");
    await herdr.prepareOwnershipRelease();
    return true;
  } catch (error) {
    if (leaseId) runtime.releaseMaintenanceRestart(leaseId);
    console.error("Unable to release enhanced Pi ownership", error);
    return false;
  }
}

async function shutdown(
  reason: string,
  requestedExitCode = 0,
  preserveWorkersRequest?: string,
): Promise<void> {
  if (
    !preserveWorkersRequest &&
    scopedShutdownPreparation &&
    (await scopedShutdownPreparation)
  )
    return;
  if (shuttingDown) return;
  shuttingDown = true;
  closeShutdownControl?.();
  sessionActivity.close();
  let exitCode = requestedExitCode;
  console.log(`Shutting down after ${reason}…`);
  diagnostics.record("info", "host_stopping", { reason, requestedExitCode });
  try {
    await application.close(preserveWorkersRequest !== undefined);
    if (statePublication) await statePublication;
  } catch (error) {
    console.error("Failed to shut down cleanly", error);
    exitCode = 1;
  } finally {
    try {
      await herdr.close();
    } catch (error) {
      console.error("Failed to close the Herdr enhancement", error);
      exitCode = 1;
    }
    try {
      await diagnostics.close();
    } catch (error) {
      console.error("Failed to close diagnostic logging", error);
      exitCode = 1;
    }
    try {
      if (statePath && publishedState) {
        await completeInstanceShutdown(
          statePath,
          publishedState,
          exitCode === requestedExitCode,
          preserveWorkersRequest,
        );
        await removeInstanceState(statePath, publishedState);
      }
    } catch (error) {
      console.error("Failed to finalize the Inspire shutdown state", error);
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
    durableWorkerRelease: true,
    ...(/^[a-f0-9]{32}$/u.test(process.env.INVOCATION_ID ?? "")
      ? { systemdInvocationId: process.env.INVOCATION_ID }
      : {}),
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
  if (statePath)
    closeShutdownControl = watchInstanceShutdown(
      statePath,
      instanceState,
      async (request) => {
        const scoped = request.scope === "host-only";
        if (scoped && herdr.enhancedWorkersEnabled) {
          scopedShutdownPreparation = prepareScopedHerdrShutdown();
          const prepared = await scopedShutdownPreparation;
          scopedShutdownPreparation = null;
          if (!prepared) {
            await refuseInstanceShutdown(
              statePath,
              instanceState,
              request.nonce,
            );
            return false;
          }
        }
        await shutdown(
          "authenticated local shutdown",
          0,
          scoped ? request.nonce : undefined,
        );
      },
    );
  diagnostics.record("info", "host_ready", { processId: process.pid });
  const url = application.launchUrl(new URL(instanceUrl(instanceState)).origin);
  if (process.env.INSPIRE_QUIET !== "1") {
    console.log(`\n  INSΠRE ${packageJson.version}`);
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
