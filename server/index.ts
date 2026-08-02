import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AttachmentStore } from "./attachments.js";
import { createInspireServer } from "./app.js";
import {
  INSTANCE_STATE_VERSION,
  consumeStopRequest,
  instanceUrl,
  processStartIdentity,
  removeInstanceState,
  writeInstanceState,
  type InstanceState,
} from "./instance-state.mjs";
import { GitInspectionService } from "./git-inspection.js";
import { MockCatalog, MockGitInspection, MockRuntime } from "./mock.js";
import { PreferencesStore } from "./preferences.js";
import { ResourceStore } from "./resources.js";
import { RuntimeController, type RuntimeLike } from "./runtime.js";
import { SessionCatalog, type SessionCatalogLike } from "./session-catalog.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piPackage = JSON.parse(await readFile(join(dirname(dirname(piEntry)), "package.json"), "utf8")) as { version: string };

const host = process.env.INSPIRE_HOST ?? "127.0.0.1";
if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
  throw new Error("insπre binds to loopback only in the local release");
}
const port = Number.parseInt(process.env.INSPIRE_PORT ?? "4587", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("INSPIRE_PORT must be a valid TCP port");
const token = process.env.INSPIRE_TOKEN ?? randomBytes(32).toString("base64url");
const mock = process.env.INSPIRE_MOCK === "1";

const attachments = new AttachmentStore();
let catalog: SessionCatalogLike;
let runtime: RuntimeLike;
if (mock) {
  catalog = new MockCatalog();
  runtime = new MockRuntime();
} else {
  catalog = new SessionCatalog(process.cwd());
  runtime = new RuntimeController(catalog, attachments);
}
const preferences = new PreferencesStore(
  process.env.INSPIRE_PREFERENCES_PATH || undefined,
);
const resources = new ResourceStore();
const git = mock ? new MockGitInspection() : new GitInspectionService();
const application = createInspireServer({
  token,
  runtime,
  catalog,
  attachments,
  preferences,
  resources,
  git,
  mock,
  version: packageJson.version,
  piVersion: piPackage.version,
  distDir: join(root, "dist"),
});

const statePath = process.env.INSPIRE_STATE_PATH;
const stopRequestPath = process.env.INSPIRE_STOP_REQUEST_PATH;
let statePublication: Promise<void> | null = null;
let shuttingDown = false;

async function shutdown(reason: string, requestedExitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  let exitCode = requestedExitCode;
  console.log(`Shutting down after ${reason}…`);
  try {
    await application.close();
    if (statePublication) await statePublication;
  } catch (error) {
    console.error("Failed to shut down cleanly", error);
    exitCode = 1;
  } finally {
    try {
      if (statePath) await removeInstanceState(statePath, process.pid);
    } catch (error) {
      console.error("Failed to remove the insπre instance state", error);
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
    console.error(`Port ${host}:${port} is already in use. insπre will not stop an unknown process.`);
  } else {
    console.error("Unable to start the insπre host", error);
  }
  void shutdown("startup failure", 1);
});

async function announceStarted(): Promise<void> {
  if (stopRequestPath && await consumeStopRequest(stopRequestPath)) {
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
    statePublication = writeInstanceState(statePath, instanceState);
    try {
      await statePublication;
    } catch (error) {
      console.error("Unable to publish the insπre instance state", error);
      await shutdown("instance-state failure", 1);
      return;
    }
  }
  if (shuttingDown) return;
  const url = instanceUrl(instanceState);
  console.log(`\n  insπre ${packageJson.version}${mock ? " (mock)" : ""}`);
  console.log(`  ${url}\n`);
  if (process.env.INSPIRE_OPEN === "1") {
    const { spawn } = await import("node:child_process");
    const opener =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    spawn(opener[0] as string, opener[1] as string[], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
}

if (stopRequestPath && await consumeStopRequest(stopRequestPath)) {
  await shutdown("a pending stop request");
} else {
  application.server.listen(port, host, () => void announceStarted());
}
process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection", error);
});
