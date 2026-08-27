#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MINIMUM_NODE = [22, 19];
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (
  nodeMajor < MINIMUM_NODE[0] ||
  (nodeMajor === MINIMUM_NODE[0] && nodeMinor < MINIMUM_NODE[1])
) {
  console.error("Node.js 22.19 or newer is required.");
  process.exit(1);
}

const scriptPath = await realpath(fileURLToPath(import.meta.url));
const root = dirname(scriptPath);
process.chdir(root);
const sourceRuntime = join(root, "server", "index.ts");
const releaseRuntime = join(root, "build", "server", "index.js");
const connectionDispatcher = join(root, "connections", "dispatch.mjs");
const hostServiceInstaller = join(root, "deploy", "systemd", "install.mjs");
const hostServiceController = join(root, "deploy", "systemd", "control.mjs");
const idleMaintenanceRunner = join(
  root,
  "deploy",
  "systemd",
  "idle-maintenance-restart.mjs",
);
const distribution =
  !(await exists(sourceRuntime)) && (await exists(releaseRuntime));
const supportRoot = distribution
  ? join(root, "build", "server")
  : join(root, "server");
const { acquireFileLock } = await import(
  pathToFileURL(join(supportRoot, "file-lock.mjs")).href
);
const { npmInvocation } = await import(
  pathToFileURL(join(supportRoot, "npm-command.mjs")).href
);
const {
  consumeStopRequest,
  inspectInstance,
  portAvailable,
  stopManagedInstance,
} = await import(pathToFileURL(join(supportRoot, "instance-state.mjs")).href);
const { inspireRuntimeDirectory } = await import(
  pathToFileURL(join(supportRoot, "platform-paths.mjs")).href
);

function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function localBin(name) {
  return join(
    root,
    "node_modules",
    ".bin",
    `${name}${process.platform === "win32" ? ".cmd" : ""}`,
  );
}

function childResult(command, args, options = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resolveResult({ code: 1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      resolveResult({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

async function runInherited(command, args, options = {}) {
  const result = await childResult(command, args, options);
  if (result.code !== 0) process.exitCode = result.code;
  return result.code;
}

async function terminateChildTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    const taskkill = process.env.SystemRoot
      ? join(process.env.SystemRoot, "System32", "taskkill.exe")
      : "taskkill.exe";
    const result = await childResult(
      taskkill,
      ["/pid", String(child.pid), "/T", "/F"],
      { capture: true },
    );
    if (result.code === 0 || child.exitCode !== null) return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The child may have exited between the final observation and kill.
  }
}

async function runNpmInherited(args, options = {}) {
  const invocation = npmInvocation(args, {
    environment: options.env ?? process.env,
    cwd: options.cwd ?? root,
  });
  return runInherited(invocation.command, invocation.args, {
    ...options,
    env: invocation.environment,
  });
}

async function dependencyHash() {
  return createHash("sha256")
    .update(await readFile(join(root, "package-lock.json")))
    .digest("hex");
}

async function ensureDependencies() {
  if (distribution) return;
  const stamp = join(root, "node_modules", ".inspire-deps");
  const expected = await dependencyHash();
  const stamped = await readFile(stamp, "utf8").catch(() => "");
  const required = await Promise.all(
    ["tsc", "vite", "tsx"].map((name) =>
      access(localBin(name), constants.X_OK).then(
        () => true,
        () => false,
      ),
    ),
  );
  if (
    (await exists(join(root, "node_modules"))) &&
    stamped.trim() === expected &&
    required.every(Boolean)
  )
    return;
  console.log("Installing dependencies…");
  const code = await runNpmInherited(["install", "--include=dev"]);
  if (code !== 0) throw new Error("Dependency installation failed");
  await writeFile(stamp, `${expected}\n`, "utf8");
}

async function sourceHash() {
  const result = await childResult(
    process.execPath,
    [join(root, "scripts", "source-build-hash.mjs")],
    { capture: true },
  );
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || "Unable to fingerprint the source");
  return result.stdout.trim();
}

async function build() {
  if (distribution) {
    console.log("This package already contains its production build.");
    return;
  }
  console.log("Building client…");
  const code = await runNpmInherited(["run", "build"]);
  if (code !== 0) throw new Error("Build failed");
}

async function ensureBuild() {
  if (distribution) {
    for (const path of [
      join(root, "dist", "index.html"),
      releaseRuntime,
      join(root, "build", "server", "instance-state.mjs"),
      join(root, "build", "server", "file-lock.mjs"),
      join(root, "build", "server", "npm-command.mjs"),
      join(root, "build", "server", "platform-paths.mjs"),
    ]) {
      if (!(await exists(path)))
        throw new Error("The installed INSΠRE package is incomplete.");
    }
    return;
  }
  const stamp = await readFile(join(root, ".inspire-build"), "utf8").catch(
    () => "",
  );
  if (
    !(await exists(join(root, "dist", "index.html"))) ||
    stamp.trim() !== (await sourceHash())
  )
    await build();
}

function openUrl(url) {
  const windowsOpener = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "rundll32.exe")
    : "rundll32.exe";
  const candidates =
    process.platform === "darwin"
      ? [["open", [url]]]
      : process.platform === "win32"
        ? [[windowsOpener, ["url.dll,FileProtocolHandler", url]]]
        : [
            ["xdg-open", [url]],
            ["gio", ["open", url]],
          ];
  const attempt = (index) => {
    const candidate = candidates[index];
    if (!candidate) return;
    try {
      const child = spawn(candidate[0], candidate[1], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      child.once("error", () => attempt(index + 1));
      child.unref();
    } catch {
      attempt(index + 1);
    }
  };
  attempt(0);
}

function explicitInstanceEnvironment() {
  return [
    "INSPIRE_STATE_PATH",
    "INSPIRE_HOST",
    "INSPIRE_PORT",
    "INSPIRE_TOKEN",
    "INSPIRE_MOCK",
  ].some((key) => Object.hasOwn(process.env, key));
}

function isHostServiceExec() {
  return (
    process.platform === "linux" &&
    process.env.SYSTEMD_EXEC_PID === String(process.pid)
  );
}

function shouldManageHostService() {
  return (
    process.platform === "linux" &&
    !isHostServiceExec() &&
    !explicitInstanceEnvironment()
  );
}

async function manageHostService(action, quiet = false) {
  if (!shouldManageHostService()) return { code: 3, output: "" };
  const result = await childResult(
    process.execPath,
    [hostServiceController, "--root", root, action],
    { capture: true },
  );
  const output = `${result.stdout}${result.stderr}`.trim();
  if (!quiet && output) console.log(output);
  return { code: result.code, output };
}

function instanceContext() {
  const host = process.env.INSPIRE_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.INSPIRE_PORT ?? "4587", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("INSPIRE_PORT must be a valid TCP port");
  const key = createHash("sha256")
    .update(root)
    .update("\0")
    .update(host)
    .update("\0")
    .update(String(port))
    .digest("hex");
  const statePath =
    process.env.INSPIRE_STATE_PATH ??
    join(inspireRuntimeDirectory(), `${key}.json`);
  return {
    root,
    host,
    port,
    statePath,
    lockPath: `${statePath}.launcher-lock`,
    stopRequestPath: `${statePath}.stop-request`,
  };
}

function expected(context, mock) {
  return {
    root: context.root,
    host: context.host,
    port: context.port,
    ...(mock === undefined ? {} : { mock }),
  };
}

async function inspect(context, mock) {
  return inspectInstance(context.statePath, expected(context, mock), {
    processMarker: distribution ? "build/server/index.js" : "server/index.ts",
  });
}

async function showExisting(context, mock) {
  const result = await inspect(context, mock);
  if (result.kind === "healthy") {
    console.log("INSΠRE is already running.");
    console.log(result.url);
    if (process.env.INSPIRE_OPEN !== "0") openUrl(result.url);
    return "shown";
  }
  if (result.kind === "unavailable") {
    console.error("A managed INSΠRE process exists but is not responding.");
    console.error("Use 'inspire restart' for an explicit graceful replacement.");
    return "blocked";
  }
  if (result.kind === "mode-conflict") {
    console.error("This port is occupied by INSΠRE in a different runtime mode.");
    console.error("Use 'inspire stop' before switching modes.");
    return "blocked";
  }
  // A stale publication is only evidence about the snapshot we inspected.
  // Leave it in place until the launcher owns the instance lock so we cannot
  // delete a replacement state published by a concurrent successful start.
  return "absent";
}

async function acquireInstanceLock(context, mock, detectExisting = true) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return await acquireFileLock(context.lockPath, {
        waitMs: Math.min(250, Math.max(1, deadline - Date.now())),
        retryMs: 25,
        label: "INSΠRE instance",
      });
    } catch (error) {
      if (error?.code !== "ELOCKTIMEOUT") throw error;
    }
    if (detectExisting) {
      const result = await inspect(context, mock);
      if (result.kind === "healthy") {
        console.log("INSΠRE is already running.");
        console.log(result.url);
        if (process.env.INSPIRE_OPEN !== "0") openUrl(result.url);
        return null;
      }
      if (result.kind === "unavailable" || result.kind === "mode-conflict")
        throw new Error("Another managed INSΠRE instance is not available");
    }
  }
  throw new Error(
    "Another INSΠRE launcher is still starting or stopping this instance.",
  );
}

function portInspectionHint(port) {
  if (process.platform === "win32")
    return `Get-NetTCPConnection -LocalPort ${port} -State Listen`;
  if (process.platform === "darwin")
    return `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
  return `ss -ltnp 'sport = :${port}'`;
}

async function requireFreePort(context) {
  if (await portAvailable(context.host, context.port)) return;
  throw new Error(
    `Port ${context.host}:${context.port} is in use, but no healthy managed INSΠRE state was found. Refusing to stop an unknown process. Inspect it with:\n  ${portInspectionHint(context.port)}`,
  );
}

function runtimeCommand() {
  if (distribution) return [process.execPath, [releaseRuntime]];
  return [
    process.execPath,
    [join(root, "node_modules", "tsx", "dist", "cli.mjs"), sourceRuntime],
  ];
}

async function superviseHost(context, mock, lease) {
  await lease.assertOwned();
  const [command, args] = runtimeCommand();
  const environment = {
    ...process.env,
    NODE_ENV: "production",
    INSPIRE_OPEN: process.env.INSPIRE_OPEN ?? "1",
    INSPIRE_INSTALLATION_ROOT: root,
    INSPIRE_STATE_PATH: context.statePath,
    INSPIRE_STOP_REQUEST_PATH: context.stopRequestPath,
    ...(mock ? { INSPIRE_MOCK: "1" } : {}),
  };
  if (!mock) delete environment.INSPIRE_MOCK;
  const child = spawn(command, args, {
    cwd: root,
    env: environment,
    windowsHide: true,
    stdio: "inherit",
  });
  let stopping = false;
  const forward = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      try {
        await stopManagedInstance(context.statePath, expected(context), {
          processMarker: distribution
            ? "build/server/index.js"
            : "server/index.ts",
          timeoutMs: 10_000,
        });
      } catch (error) {
        console.error(
          `Unable to complete graceful Host shutdown: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await terminateChildTree(child);
      }
    })();
  };
  const onInt = () => forward();
  const onTerm = () => forward();
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  try {
    return await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        resolveExit(code ?? (signal ? 1 : 0)),
      );
    });
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    await lease.release();
  }
}

async function startHost(mock = false, allowService = true, retained = null) {
  if (retained && allowService)
    throw new Error(
      "A retained local instance lock cannot be delegated to systemd",
    );
  if (!mock && allowService) {
    const service = await manageHostService("start");
    if (service.code === 0) return 0;
    if (service.code !== 3) return service.code;
  }

  const context = retained?.context ?? instanceContext();
  let lease = retained?.lease ?? null;
  try {
    await mkdir(dirname(context.statePath), { recursive: true, mode: 0o700 });
    if (!lease) {
      const existing = await showExisting(context, mock);
      if (existing === "shown") return 0;
      if (existing === "blocked") return 1;
      lease = await acquireInstanceLock(context, mock);
      if (!lease) return 0;
    }

    const afterLock = await showExisting(context, mock);
    if (afterLock === "shown") return 0;
    if (afterLock === "blocked") return 1;
    await lease.assertOwned();
    await requireFreePort(context);
    await ensureDependencies();
    await ensureBuild();
    await lease.assertOwned();
    if (await consumeStopRequest(context.stopRequestPath)) {
      console.log("INSΠRE startup was cancelled by a concurrent stop request.");
      return 0;
    }

    const hostLease = lease;
    lease = null;
    return await superviseHost(context, mock, hostLease);
  } finally {
    await lease?.release();
  }
}

async function tryShortLock(context) {
  try {
    return await acquireFileLock(context.lockPath, {
      waitMs: 75,
      retryMs: 20,
      label: "INSΠRE instance",
    });
  } catch (error) {
    if (error?.code === "ELOCKTIMEOUT") return null;
    throw error;
  }
}

async function placeStopRequest(context) {
  await writeFile(
    context.stopRequestPath,
    `stop requested at ${new Date().toISOString()}\n`,
    { mode: 0o600 },
  );
}

async function acquireRestartLease(context) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // A startup that wins the OS scheduling race must consume this request and
    // release its lease instead of publishing a replacement Host. Reinstall it
    // on every pass because consumption is intentionally one-shot.
    await placeStopRequest(context);
    const lease = await tryShortLock(context);
    if (lease) {
      await rm(context.stopRequestPath, { force: true });
      return lease;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(
    "Timed out reserving the INSΠRE instance lock for restart; no replacement was started.",
  );
}

async function completeLocalStop(
  context,
  message,
  retainLease,
  acquiredLease = null,
) {
  let lease = acquiredLease;
  try {
    if (retainLease && !lease) lease = await acquireRestartLease(context);
    await rm(context.stopRequestPath, { force: true });
    if (!retainLease) {
      await lease?.release();
      lease = null;
    }
    console.log(message);
    return { code: 0, context, lease };
  } catch (error) {
    await lease?.release();
    await rm(context.stopRequestPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function failLocalStop(context, message) {
  await rm(context.stopRequestPath, { force: true }).catch(() => undefined);
  console.error(message);
  return { code: 1, context, lease: null };
}

async function stopLocalHost(retainLease = false) {
  const context = instanceContext();
  await mkdir(dirname(context.statePath), { recursive: true, mode: 0o700 });
  if (retainLease) await placeStopRequest(context);

  const result = await stopManagedInstance(
    context.statePath,
    expected(context),
    {
      processMarker: distribution ? "build/server/index.js" : "server/index.ts",
    },
  );
  if (result.kind === "stopped") {
    return completeLocalStop(
      context,
      `Stopped INSΠRE process ${result.state.pid}.`,
      retainLease,
    );
  }
  if (result.kind === "unavailable") {
    return failLocalStop(
      context,
      "The managed process could not be stopped safely.",
    );
  }
  if (result.kind === "timeout") {
    return failLocalStop(
      context,
      "Timed out waiting for INSΠRE to stop; it was not force-killed.",
    );
  }

  const lease = await tryShortLock(context);
  if (lease) {
    return completeLocalStop(
      context,
      "No managed INSΠRE instance is running.",
      retainLease,
      lease,
    );
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await placeStopRequest(context);
    const pending = await stopManagedInstance(
      context.statePath,
      expected(context),
      {
        processMarker: distribution
          ? "build/server/index.js"
          : "server/index.ts",
        healthTimeoutMs: 250,
        timeoutMs: 5_000,
      },
    );
    if (pending.kind === "stopped") {
      return completeLocalStop(
        context,
        "Stopped the INSΠRE instance that was starting.",
        retainLease,
      );
    }
    if (pending.kind === "unavailable" || pending.kind === "timeout") {
      return failLocalStop(
        context,
        "Unable to stop the INSΠRE instance that was starting.",
      );
    }
    const acquired = await tryShortLock(context);
    if (acquired) {
      return completeLocalStop(
        context,
        "Cancelled the pending INSΠRE startup.",
        retainLease,
        acquired,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return failLocalStop(
    context,
    "Timed out waiting for the pending INSΠRE startup; it was not force-killed.",
  );
}

async function stopHost(allowService = true) {
  if (allowService) {
    const service = await manageHostService("stop");
    if (service.code === 0) return 0;
    if (service.code !== 3) return service.code;
  }
  return (await stopLocalHost()).code;
}

async function restartHost() {
  const service = await manageHostService("restart");
  if (service.code === 0) return 0;
  if (service.code !== 3) return service.code;

  const stopped = await stopLocalHost(true);
  if (stopped.code !== 0) return stopped.code;
  return startHost(false, false, stopped);
}

async function statusHost() {
  const service = await manageHostService("status", true);
  if (service.code === 0) {
    const context = instanceContext();
    const result = await inspect(context, false);
    if (result.kind === "healthy") {
      if (service.output) console.log(service.output);
      console.log(result.url);
      return 0;
    }
    console.error("INSΠRE system service is active, but its Host is not reachable.");
    return 1;
  }
  if (service.code !== 3 && service.code !== 5) {
    if (service.output) console.error(service.output);
    return service.code;
  }
  if (service.code === 5 && service.output) console.log(service.output);

  const context = instanceContext();
  let result = await inspect(context, false);
  if (result.kind === "healthy") {
    console.log("INSΠRE is running.");
    console.log(result.url);
    return 0;
  }
  if (result.kind === "mode-conflict") result = await inspect(context, true);
  if (result.kind === "healthy") {
    console.log("INSΠRE mock is running.");
    console.log(result.url);
    return 0;
  }
  if (result.kind === "unavailable")
    console.error("A managed INSΠRE process exists but is not responding.");
  else console.error("INSΠRE is not running.");
  return 1;
}

async function waitReady() {
  const context = instanceContext();
  while (true) {
    const result = await inspect(context, false);
    if (result.kind === "healthy") return 0;
    if (result.kind === "mode-conflict") {
      console.error("The system service started in the wrong INSΠRE runtime mode.");
      return 1;
    }
    const mainPid = Number.parseInt(process.env.MAINPID ?? "", 10);
    if (Number.isInteger(mainPid) && mainPid > 0) {
      try {
        process.kill(mainPid, 0);
      } catch {
        console.error("The INSΠRE Host process exited before becoming ready.");
        return 1;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

async function runNodeEntry(entry, args) {
  return runInherited(process.execPath, [entry, "--root", root, ...args]);
}

function requireLinuxService() {
  if (process.platform === "linux") return;
  throw Object.assign(
    new Error("INSΠRE user-service commands require Linux systemd."),
    { exitCode: 64 },
  );
}

function printHelp() {
  console.log(`Usage:\n  inspire                 start the configured service or local Host\n  inspire restart         restart the service or local Host\n  inspire stop            stop the service or local Host\n  inspire status          inspect the service or local Host\n  inspire mock            run the UI-only mock Host\n  inspire dev             run Vite and the development Host\n  inspire build           build the source checkout\n  inspire connection <name> [action]\n  inspire --ssh-reverse [action]\n  inspire service [install-host|enable-host|disable-host|status-host]\n\nCore lifecycle commands support Linux, macOS, and Windows. System service\ncommands remain Linux-only.`);
}

async function main() {
  const [mode = "start", ...args] = process.argv.slice(2);
  switch (mode) {
    case "":
    case "start":
    case "host":
      return startHost(false);
    case "mock":
      return startHost(true, false);
    case "stop":
      return stopHost();
    case "restart":
      return restartHost();
    case "status":
      return statusHost();
    case "wait-ready":
      return waitReady();
    case "maintenance-restart":
      requireLinuxService();
      return runNodeEntry(idleMaintenanceRunner, [
        "--state",
        instanceContext().statePath,
        "--controller",
        hostServiceController,
      ]);
    case "dev": {
      if (distribution)
        throw new Error("Development mode requires a source checkout.");
      await ensureDependencies();
      const token = process.env.INSPIRE_TOKEN ?? "inspire-dev-token";
      const url = `http://127.0.0.1:5173/?token=${encodeURIComponent(token)}`;
      console.log(`Dev host token: ${token}`);
      console.log(`Open ${url} after Vite starts.`);
      openUrl(url);
      return runNpmInherited(["run", "dev"], {
        env: { ...process.env, INSPIRE_TOKEN: token },
      });
    }
    case "build":
      await ensureDependencies();
      await build();
      return 0;
    case "connection":
      return runNodeEntry(connectionDispatcher, args);
    case "--ssh-reverse":
      return runNodeEntry(connectionDispatcher, ["ssh-reverse", ...args]);
    case "service": {
      requireLinuxService();
      const [action] = args;
      if (action === "install-host")
        return runNodeEntry(hostServiceInstaller, ["install-host"]);
      const controls = {
        "enable-host": "enable",
        "disable-host": "disable",
        "status-host": "status",
      };
      if (!controls[action]) {
        console.error("Use: inspire service [install-host|enable-host|disable-host|status-host]");
        return 64;
      }
      return runNodeEntry(hostServiceController, [controls[action]]);
    }
    case "-h":
    case "--help":
    case "help":
      printHelp();
      return 0;
    default:
      console.error(`Unknown mode: ${mode}`);
      printHelp();
      return 1;
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = Number(error?.exitCode) || 1;
}
