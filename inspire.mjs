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

const invocationCwd = process.cwd();
const scriptPath = await realpath(fileURLToPath(import.meta.url));
const root = dirname(scriptPath);
process.chdir(root);
const sourceRuntime = join(root, "server", "index.ts");
const releaseRuntime = join(root, "build", "server", "index.js");
const hostServiceInstaller = join(root, "deploy", "systemd", "install.mjs");
const distribution =
  !(await exists(sourceRuntime)) && (await exists(releaseRuntime));
const supportRoot = distribution
  ? join(root, "build", "server")
  : join(root, "server");
const { acquireFileLock } = await import(
  pathToFileURL(join(supportRoot, "file-lock.mjs")).href
);
const { openBrowser } = await import(
  pathToFileURL(join(supportRoot, "browser-opener.mjs")).href
);
const { npmInvocation } = await import(
  pathToFileURL(join(supportRoot, "npm-command.mjs")).href
);
const {
  assertInstanceTarget,
  consumeStopRequest,
  hostListener,
  inspectInstance,
  instanceLaunchUrl,
  observeProcessExit,
  portAvailable,
  stopManagedInstance,
} = await import(pathToFileURL(join(supportRoot, "instance-state.mjs")).href);
const { inspireRuntimeDirectory, installationKey, resolveUserPath } = await import(
  pathToFileURL(join(supportRoot, "platform-paths.mjs")).href
);
const { runChild, signalProcessTree } = await import(
  pathToFileURL(join(supportRoot, "process-tree.mjs")).href
);
const { createLauncherRestartSupervisor } = await import(
  pathToFileURL(join(supportRoot, "launcher-restart.mjs")).href
);
const { resolveLaunchEnvironment } = await import(
  pathToFileURL(join(supportRoot, "user-environment.mjs")).href
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

async function runInherited(command, args, options = {}) {
  const result = await runChild(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    windowsHide: true,
    stdio: "inherit",
  });
  if (result.code !== 0) process.exitCode = result.code;
  return result.code;
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
  if (stamped.trim() === expected && required.every(Boolean)) return;
  console.log("Installing dependencies…");
  const code = await runNpmInherited(["install", "--include=dev"]);
  if (code !== 0) throw new Error("Dependency installation failed");
  await writeFile(stamp, `${expected}\n`, "utf8");
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
    const required = [join(root, "dist", "index.html"), join(supportRoot, "terminal-daemon-entry.js")];
    for (const path of required) {
      if (!(await exists(path)))
        throw new Error("The installed INSΠRE package is incomplete.");
    }
    return;
  }
  const stamp = await readFile(join(root, ".inspire-build"), "utf8").catch(() => "");
  if (stamp && (await exists(join(root, "dist", "index.html")))) {
    const { sourceBuildHash } = await import("./scripts/source-build-hash.mjs");
    if (stamp.trim() === (await sourceBuildHash(root))) return;
  }
  await build();
}

function defaultInstanceStatePath(host, port) {
  const key = installationKey(root, host, port);
  return join(inspireRuntimeDirectory(), `${key}.json`);
}

async function targetsServiceInstance(context) {
  if (
    context.host !== "127.0.0.1" ||
    context.port !== 4587 ||
    resolve(context.statePath) !==
      resolve(defaultInstanceStatePath(context.host, context.port))
  )
    return false;
  // Inherited defaults still address the installed service. A credential override
  // can delegate only when the authenticated running instance already uses it.
  if (process.env.INSPIRE_TOKEN) {
    const current = await inspect(context);
    return (
      current.kind === "healthy" &&
      current.state.token === process.env.INSPIRE_TOKEN
    );
  }
  return true;
}

function isHostServiceExec() {
  return (
    process.platform === "linux" &&
    process.env.SYSTEMD_EXEC_PID === String(process.pid)
  );
}

async function serviceController(context) {
  if (
    process.platform !== "linux" ||
    isHostServiceExec() ||
    !(await targetsServiceInstance(context))
  )
    return null;
  return import("./deploy/systemd/control.mjs");
}

function instanceContext() {
  const { host, port } = hostListener();
  const statePath =
    process.env.INSPIRE_STATE_PATH ?? defaultInstanceStatePath(host, port);
  return {
    root,
    host,
    port,
    statePath,
    lockPath: `${statePath}.lock`,
    stopRequestPath: `${statePath}.stop-request`,
  };
}

async function inspect(context) {
  return inspectInstance(context.statePath, context);
}

function reportUnavailableHost() {
  console.error("Cannot authenticate readiness of the managed INSΠRE Host.");
  console.error(
    "If it remains unavailable, stop the instance through its launcher or service manager before starting it again.",
  );
}

async function showInstanceUrl(result, open = false) {
  const url = await instanceLaunchUrl(result.state);
  console.log(url ?? result.url);
  if (!url) {
    console.error(
      "Could not authenticate a local pairing link. Retry after checking the Host.",
    );
    return;
  }
  if (open) void openBrowser(url).catch((error) => console.error(error.message));
}

async function showExisting(context, waitingForLock = false) {
  const result = await inspect(context);
  if (result.kind === "healthy") {
    console.log("INSΠRE is already running.");
    await showInstanceUrl(result, process.env.INSPIRE_OPEN !== "0");
    return "shown";
  }
  if (result.kind === "unavailable") {
    if (waitingForLock)
      throw new Error("Another managed INSΠRE instance is not available");
    reportUnavailableHost();
    return "blocked";
  }
  // A stale publication is only evidence about the snapshot we inspected.
  // Leave it in place until the launcher owns the instance lock so we cannot
  // delete a replacement state published by a concurrent successful start.
  return "absent";
}

async function tryInstanceLock(context, waitMs, retryMs) {
  try {
    return await acquireFileLock(context.lockPath, {
      waitMs,
      retryMs,
      label: "INSΠRE instance",
    });
  } catch (error) {
    if (error?.code === "ELOCKTIMEOUT") return null;
    throw error;
  }
}

async function acquireInstanceLock(context) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const lease = await tryInstanceLock(
      context,
      Math.min(250, Math.max(1, deadline - Date.now())),
      25,
    );
    if (lease || (await showExisting(context, true)) === "shown") return lease;
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

function runtimeArgs(name, args = []) {
  const entry = join(supportRoot, name + (distribution ? ".js" : ".ts"));
  return distribution
    ? [entry, ...args]
    : ["--import", import.meta.resolve("tsx"), entry, ...args];
}

async function superviseHost(context, lease) {
  let child = null;
  let stopping = false;
  let restarting = false;
  // Installed services retain systemd as lifecycle authority. Direct launches
  // use a private parent/child channel, including alternate ports and hosts.
  const pageRestart = !isHostServiceExec();
  const forward = () => {
    if (stopping) return;
    stopping = true;
    const currentChild = child;
    if (!currentChild) return;
    void (async () => {
      try {
        await stopManagedInstance(context.statePath, context, {
          timeoutMs: 10_000,
        });
      } catch (error) {
        console.error(
          `Unable to complete graceful Host shutdown: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await signalProcessTree(currentChild, "SIGKILL");
      }
    })();
  };
  const onInt = () => forward();
  const onTerm = () => forward();
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  try {
    for (;;) {
      await lease.assertOwned();
      if (stopping || (await consumeStopRequest(context.stopRequestPath)))
        return 0;
      if (restarting) await requireFreePort(context);
      if (stopping) return 0;
      const environment = {
        ...process.env,
        INSPIRE_OPEN: restarting ? "0" : (process.env.INSPIRE_OPEN ?? "1"),
        INSPIRE_INSTALLATION_ROOT: root,
        INSPIRE_STATE_PATH: context.statePath,
        INSPIRE_STOP_REQUEST_PATH: context.stopRequestPath,
      };
      child = spawn(process.execPath, runtimeArgs("index"), {
        cwd: root,
        env: environment,
        windowsHide: true,
        stdio: pageRestart
          ? ["inherit", "inherit", "inherit", "ipc"]
          : "inherit",
      });
      const restart = createLauncherRestartSupervisor(child, {
        enabled: pageRestart,
        isStopping: () => stopping,
        assertOwned: () => lease.assertOwned(),
      });
      let result;
      try {
        result = await new Promise((resolveExit, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolveExit({ code, signal }));
        });
      } finally {
        restart.close();
        child = null;
      }
      // Failed worker retirement, a crash, signal, or ordinary stop is not
      // permission to start a replacement. Keep one lock across clean restarts.
      if (!restart.shouldRestart(result.code, result.signal))
        return result.code ?? (result.signal ? 1 : 0);
      restarting = true;
      console.log("Restarting INSΠRE Host. Terminals remain running.");
    }
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    await lease.release();
  }
}

async function startLocalHost(context, lease = null) {
  try {
    await mkdir(dirname(context.statePath), { recursive: true, mode: 0o700 });
    if (!lease) {
      const existing = await showExisting(context);
      if (existing === "shown") return 0;
      if (existing === "blocked") return 1;
      lease = await acquireInstanceLock(context);
      if (!lease) return 0;
    }

    const afterLock = await showExisting(context);
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
    return await superviseHost(context, hostLease);
  } finally {
    await lease?.release();
  }
}

async function placeStopRequest(context) {
  await writeFile(
    context.stopRequestPath,
    `stop requested at ${new Date().toISOString()}\n`,
    { mode: 0o600 },
  );
}

const localStopErrors = {
  unavailable: "The managed process could not be stopped safely.",
  timeout: "Timed out waiting for INSΠRE to stop; it was not force-killed.",
  "cleanup-failed":
    "The Host could not confirm clean owned-worker shutdown. No replacement was started.",
};

async function stopLocalHost(context, restart = false, target) {
  await mkdir(dirname(context.statePath), { recursive: true, mode: 0o700 });

  let lease = null;
  let cancellationPublished = false;
  let waitingForStartup = false;
  let stoppedMessage = null;
  let deadline = Infinity;
  try {
    while (Date.now() < deadline) {
      if (target) await assertInstanceTarget(context.statePath, target);
      // Cancellation is consumed once. Keep publishing it until this command
      // owns the launcher's lock, even after the Host's state disappears.
      await placeStopRequest(context);
      cancellationPublished = true;
      if (!stoppedMessage) {
        const result = await stopManagedInstance(
          context.statePath,
          context,
          { target, ...(waitingForStartup ? { timeoutMs: 5_000 } : {}) },
        );
        if (result.kind === "stopped") {
          stoppedMessage = waitingForStartup
            ? "Stopped the INSΠRE instance that was starting."
            : `Stopped INSΠRE process ${result.state.pid}.`;
          deadline = Date.now() + 30_000;
          continue;
        }
        if (localStopErrors[result.kind])
          throw new Error(
            waitingForStartup
              ? "Unable to stop the INSΠRE instance that was starting."
              : localStopErrors[result.kind],
          );
      }

      lease = await tryInstanceLock(context, 75, 20);
      if (lease) {
        await rm(context.stopRequestPath, { force: true });
        cancellationPublished = false;
        console.log(
          stoppedMessage ??
            (waitingForStartup
              ? "Cancelled the pending INSΠRE startup."
              : "No managed INSΠRE instance is running."),
        );
        if (!restart) return 0;
        const retained = lease;
        lease = null;
        return await startLocalHost(context, retained);
      }
      if (stoppedMessage || waitingForStartup)
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, stoppedMessage ? 50 : 100),
        );
      else {
        waitingForStartup = true;
        deadline = Date.now() + 30_000;
      }
    }
    throw new Error(
      stoppedMessage
        ? "Timed out waiting for the INSΠRE launcher to finish stopping."
        : "Timed out waiting for the pending INSΠRE startup; it was not force-killed.",
    );
  } finally {
    if (cancellationPublished)
      await rm(context.stopRequestPath, { force: true }).catch(() => undefined);
    await lease?.release();
  }
}

async function hostLifecycle(action) {
  const context = instanceContext();
  const systemd = await serviceController(context);
  if (systemd) {
    const result = await systemd.manageHostService(root, action);
    if (result.kind !== "absent") return systemd.reportHostService(result, action);
  }
  return action === "start" ? startLocalHost(context) : stopLocalHost(context);
}

async function prepareRestart() {
  await ensureDependencies();
  await ensureBuild();
  if ((await runInherited(process.execPath, runtimeArgs("restart-preflight"), {
    env: { ...process.env, INSPIRE_INSTALLATION_ROOT: root },
  })) !== 0)
    throw new Error(
      "Restart preparation failed. The running Host was not stopped.",
    );
}

async function restartHost(scope = "host") {
  const allPi = scope === "all-pi";
  const terminals = scope !== "host";
  if (terminals && process.env.INSPIRE_TERMINAL_ID)
    throw new Error(
      "Run this restart from an external OS terminal. It can close the terminal running this command before reporting the result.",
    );
  const context = instanceContext();
  const systemd = await serviceController(context);
  const service = await systemd?.inspectHostService(root);
  if (service && service.kind !== "managed" && service.kind !== "absent")
    return systemd.reportHostService(service, "status");
  if (terminals && service?.kind !== "managed")
    throw new Error(
      "Full restart requires this installation's Linux systemd services. No service was restarted.",
    );

  let stopPi;
  if (allPi) {
    const processes = await import(pathToFileURL(join(supportRoot, "pi-processes.mjs")).href);
    if (!processes.supportsGlobalPiStop())
      throw new Error("Restart all requires Linux Pi process control.");
    await processes.assertExternalPiRestartCaller();
    stopPi = processes.stopAllPiProcesses;
  }
  console.log("Preparing restart…");
  await prepareRestart();
  const owner = await inspect(context);
  if (owner.kind === "unavailable")
    throw new Error("Cannot verify the running Host for restart.");

  if (service?.kind !== "managed") {
    const current = await systemd?.inspectHostService(root);
    if (current && current.kind !== "absent")
      throw new Error("The installed service changed during preparation. Inspect it before retrying.");
    console.log("Restarting INSΠRE Host. Terminals remain running.");
    return stopLocalHost(context, true, owner.kind === "healthy" ? owner.state : undefined);
  }
  if (owner.kind === "healthy" && owner.state.systemdInvocationId !== service.invocationId)
    throw new Error("The running Host does not belong to the inspected service invocation.");
  if (!allPi) {
    const action = terminals ? "restart-all" : "restart";
    return systemd.reportHostService(
      await systemd.manageHostService(root, action, { target: service }),
      action,
    );
  }

  let includeHerdr = false;
  if (owner.kind === "healthy") {
    const { requestInstanceControl } = await import(
      pathToFileURL(join(supportRoot, "instance-control.mjs")).href
    );
    const mode = await requestInstanceControl(owner.state, "restart-mode");
    if (!mode || typeof mode.includeHerdr !== "boolean")
      throw new Error("Cannot read the running Herdr mode. Restart Inspire normally before using --all.");
    includeHerdr = mode.includeHerdr;
  } else if (service.activeState === "active") {
    throw new Error("Cannot read the running Herdr mode. No processes were stopped.");
  }
  console.log(includeHerdr
    ? "Closing Pi sessions, including Herdr sessions."
    : "Closing Pi sessions outside Herdr.");
  const stopped = await systemd.manageHostService(root, "stop", { target: service });
  if (systemd.reportHostService(stopped, "stop") !== 0)
    throw new Error("The managed services could not be stopped. No global Pi cleanup was attempted.");
  if (owner.kind === "healthy" && !(await observeProcessExit(owner.state, 15_000)))
    throw new Error("Host exit was not confirmed. No global Pi cleanup was attempted.");
  await stopPi({ includeHerdr });
  const started = await systemd.manageHostService(root, "start", { target: stopped.service });
  if (systemd.reportHostService(started, "start") !== 0)
    throw new Error("Pi sessions were closed, but Inspire could not be restarted.");
  console.log("Closed Pi sessions and restarted Inspire.");
  return 0;
}

async function statusHost() {
  const context = instanceContext();
  const systemd = await serviceController(context);
  const service = await systemd?.inspectHostService(root);
  if (service && service.kind !== "managed" && service.kind !== "absent")
    return systemd.reportHostService(service, "status");
  const result = await inspect(context);
  if (service?.kind === "managed" &&
      (service.activeState !== "active" || result.kind === "healthy"))
    systemd.reportHostService(service, "status");
  if (result.kind === "healthy") {
    if (service?.activeState !== "active") console.log("INSΠRE is running.");
    await showInstanceUrl(result);
    return 0;
  }
  if (result.kind === "unavailable") reportUnavailableHost();
  else if (service?.activeState === "active")
    console.error("INSΠRE system service is active, but its Host is not reachable.");
  else console.error("INSΠRE is not running.");
  return 1;
}

async function waitReady() {
  const context = instanceContext();
  while (true) {
    const result = await inspect(context);
    if (result.kind === "healthy") return 0;
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
  console.log(
    `Usage:\n  inspire                 start the configured service or local Host\n  inspire restart             restart Inspire and its Pi workers; keep terminals\n  inspire restart --terminals  also close project terminals (Linux services)\n  inspire restart --all        close Pi sessions and restart; include Herdr in enhanced mode (Linux services)\n  inspire stop            stop the service or local Host\n  inspire status          inspect the service or local Host\n  inspire token           show the verified Host token for manual pairing\n  inspire recover-session <folder>  restore a session recovery bundle\n  inspire pi [--session <session.jsonl>]  open native Pi with remote queue receipts\n  inspire terminal <status|stop|restart> [--force]  manage this instance\'s terminals\n  inspire dev             run Vite and the development Host\n  inspire build           build the source checkout\n  inspire connection list | <name> [action]\n  inspire --ssh-reverse [action]\n  inspire service [install-host|enable-host|disable-host|status-host]\n\nCore lifecycle commands support Linux, macOS, and Windows. System service\ncommands remain Linux-only.`,
  );
}

async function main() {
  const environment = await resolveLaunchEnvironment(process.env, {
    service: isHostServiceExec(),
  });
  for (const key of Object.keys(process.env)) {
    if (environment[key] === undefined) delete process.env[key];
  }
  Object.assign(process.env, environment);
  const [mode = "start", ...args] = process.argv.slice(2);
  switch (mode) {
    case "":
    case "start":
    case "host":
      return hostLifecycle("start");
    case "stop":
      return hostLifecycle("stop");
    case "restart":
      if (args.length > 1 || (args.length === 1 && !["--all", "--terminals"].includes(args[0]))) {
        console.error("Use: inspire restart [--all | --terminals]");
        return 64;
      }
      return restartHost(args[0] === "--all" ? "all-pi"
        : args[0] === "--terminals" ? "all"
        : "host");
    case "recover-session": {
      if (args.length !== 1) {
        console.error("Use: inspire recover-session <bundle-folder>");
        return 64;
      }
      await ensureDependencies();
      const bundle = resolveUserPath(args[0], invocationCwd);
      return runInherited(process.execPath, runtimeArgs("session-recovery-entry", [bundle]));
    }
    case "prepare-restart":
      if (args.length) return 64;
      await prepareRestart();
      return 0;
    case "status":
      return statusHost();
    case "token": {
      if (args.length) return 64;
      const result = await inspect(instanceContext());
      if (result.kind !== "healthy") {
        if (result.kind === "unavailable") reportUnavailableHost();
        else
          console.error(
            "No authenticated matching Host; no token was displayed.",
          );
        return 1;
      }
      console.log(result.state.token);
      return 0;
    }
    case "wait-ready":
      return waitReady();
    case "maintenance-restart": {
      requireLinuxService();
      const { runScheduledRestart } = await import("./deploy/systemd/idle-maintenance-restart.mjs");
      return runScheduledRestart(root, instanceContext().statePath);
    }
    case "dev": {
      if (distribution)
        throw new Error("Development mode requires a source checkout.");
      await ensureDependencies();
      await import(pathToFileURL(join(root, "scripts", "start-dev.mjs")).href);
      return process.exitCode ?? 0;
    }
    case "build":
      await ensureDependencies();
      await build();
      return 0;
    case "pi": {
      await ensureDependencies();
      return runInherited(process.execPath, runtimeArgs("attached-pi-entry", args), {
        cwd: invocationCwd,
        env: { ...process.env, INSPIRE_INSTALLATION_ROOT: root },
      });
    }
    case "terminal":
    case "terminal-daemon": {
      await ensureDependencies();
      const entry = mode === "terminal" ? "terminal-control-entry" : "terminal-daemon-entry";
      return runInherited(process.execPath, runtimeArgs(entry, args));
    }
    case "connection":
    case "--ssh-reverse": {
      const { dispatchConnection } = await import("./connections/dispatch.mjs");
      const connectionArgs = mode === "connection" ? args : ["ssh-reverse", ...args];
      return dispatchConnection(root, connectionArgs, runNodeEntry);
    }
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
        console.error(
          "Use: inspire service [install-host|enable-host|disable-host|status-host]",
        );
        return 64;
      }
      const systemd = await import("./deploy/systemd/control.mjs");
      const command = controls[action];
      const result = command === "status"
        ? await systemd.inspectHostService(root)
        : await systemd.manageHostService(root, command);
      return systemd.reportHostService(result, command);
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
