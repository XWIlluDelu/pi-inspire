import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { acquireFileLock } from "./file-lock.mjs";
import { processStartIdentity } from "./instance-state.mjs";
import { TerminalDaemonClient } from "./terminal-daemon-client.js";
import {
  resolveTerminalDaemonConfiguration,
  sameTerminalDaemonConfiguration,
  type TerminalDaemonConfiguration,
  type TerminalDaemonInfo,
  type TerminalDaemonLaunchOptions,
} from "./terminal-daemon-configuration.js";
import { launchTerminalDaemon } from "./terminal-daemon-launcher.js";
import { legacyTerminalDaemonAddress } from "./terminal-daemon-protocol.js";
import { addressAcceptsConnections } from "./terminal-daemon-socket.js";
import { readTerminalDaemonSecret } from "./terminal-daemon-tls.js";
import { TerminalServiceError } from "./terminal-service.js";
import { prepareTerminalStateDirectory } from "./terminal-state-store.js";

const execFile = promisify(execFileCallback);
const STOP_TIMEOUT_MS = 20_000;
const LEGACY_GUIDANCE =
  "A terminal endpoint is listening without verified lifecycle controls. Refusing to guess a PID or replace its PTYs. Upgrade it once through its existing service manager or manually stop the inspected terminal daemon. Host-only restart cannot replace it.";

type TerminalDaemonStatus =
  | { kind: "running"; info: TerminalDaemonInfo }
  | { kind: "stopped" }
  | { kind: "unavailable"; message: string };

function validInfo(
  info: TerminalDaemonInfo,
  config: TerminalDaemonConfiguration,
): boolean {
  return (
    info?.lifecycleVersion === 1 &&
    typeof info.instanceId === "string" &&
    /^[0-9a-f-]{36}$/.test(info.instanceId) &&
    Number.isSafeInteger(info.pid) &&
    info.pid > 0 &&
    typeof info.processStartTime === "string" &&
    info.processStartTime.length > 0 &&
    typeof info.stopping === "boolean" &&
    Number.isSafeInteger(info.runningTerminals) &&
    info.runningTerminals >= 0 &&
    info.configuration != null &&
    sameTerminalDaemonConfiguration(config, info.configuration) &&
    (info.systemdUnit === null ||
      info.systemdUnit === "inspire-terminal.service")
  );
}

async function clientFor(
  config: TerminalDaemonConfiguration,
): Promise<TerminalDaemonClient> {
  return new TerminalDaemonClient(
    config.address,
    await readTerminalDaemonSecret(config.tokenPath),
  );
}

async function assertProcess(info: TerminalDaemonInfo): Promise<void> {
  if ((await processStartIdentity(info.pid)) !== info.processStartTime)
    throw new Error(
      "The terminal daemon process identity changed; inspect it again.",
    );
}

export async function inspectTerminalDaemon(
  options: TerminalDaemonLaunchOptions,
): Promise<TerminalDaemonStatus> {
  const config = resolveTerminalDaemonConfiguration(options);
  let client: TerminalDaemonClient | undefined;
  try {
    client = await clientFor(config);
    const info = await client.daemonInfo();
    if (!validInfo(info, config))
      throw new TerminalServiceError(
        "terminal_scope_mismatch",
        409,
        "The authenticated terminal endpoint belongs to a different instance.",
      );
    await assertProcess(info);
    return { kind: "running", info };
  } catch (error) {
    // A verified foreign owner is not absence, even if it stopped listening
    // after its response. Never use that error as replacement authority.
    if (
      error instanceof TerminalServiceError &&
      error.code === "terminal_scope_mismatch"
    )
      return { kind: "unavailable", message: error.message };
    const legacy = legacyTerminalDaemonAddress(
      config.root,
      config.host,
      config.port,
      { environment: options.environment ?? process.env },
    );
    if (
      (await addressAcceptsConnections(config.address)) ||
      (legacy !== config.address && (await addressAcceptsConnections(legacy)))
    )
      return {
        kind: "unavailable",
        message: LEGACY_GUIDANCE,
      };
    // A missing listener is not proof of exit. A control request keeps its
    // captured process identity until confirmed below; status grants no stop.
    return { kind: "stopped" };
  } finally {
    await client?.close();
  }
}

async function waitForExit(
  info: TerminalDaemonInfo,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await processStartIdentity(info.pid)) !== info.processStartTime)
        return;
      if (process.platform === "linux") {
        // Linux retains /proc for a reaped-later child zombie.
        const raw = await readFile(`/proc/${info.pid}/stat`, "utf8");
        if (raw.slice(raw.lastIndexOf(")") + 2).startsWith("Z ")) return;
      }
    } catch (error) {
      try {
        process.kill(info.pid, 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") return;
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Cannot confirm the terminal daemon's process exit.");
    }
    await delay(75);
  }
  throw new Error(
    "Terminal shutdown is unconfirmed. No replacement was started; run terminal status before retrying.",
  );
}

export async function controlTerminalDaemon(
  action: "stop" | "restart",
  options: TerminalDaemonLaunchOptions,
  force: boolean,
): Promise<TerminalDaemonInfo | null> {
  if ((options.environment ?? process.env).INSPIRE_TERMINAL_ID)
    throw new Error(
      "Run terminal stop/restart from an external OS terminal, not an Inspire project terminal: shutdown can terminate the command before it completes. No work was stopped.",
    );
  const config = resolveTerminalDaemonConfiguration(options);
  await prepareTerminalStateDirectory(config.statePath);
  const control = await acquireFileLock(config.statePath + ".control.lock", {
    waitMs: 25_000,
    label: "terminal lifecycle control",
  });
  try {
    const status = await inspectTerminalDaemon(options);
    if (status.kind === "unavailable") throw new Error(status.message);
    let unit: string | null = null;
    if (status.kind === "running") {
      unit = status.info.systemdUnit;
      const client = await clientFor(config);
      try {
        await client.shutdownDaemon(status.info.instanceId, force);
      } catch (error) {
        // A definite refusal (including busy/changed-owner) is not acceptance.
        if (
          error &&
          typeof error === "object" &&
          "status" in error &&
          typeof error.status === "number" &&
          error.status < 500
        )
          throw error;
        // An acknowledgement can be lost during shutdown. Only actual exit
        // resolves it; the missing socket alone never permits replacement.
      } finally {
        await client.close();
      }
      await waitForExit(status.info, STOP_TIMEOUT_MS);
    }
    await control.assertOwned();
    // Absence of a listener alone is not permission to overlap an owner that
    // is still starting/draining. The lifetime lease fences that handoff.
    const handoff = await acquireFileLock(config.statePath + ".daemon.lock", {
      waitMs: STOP_TIMEOUT_MS,
      label: "terminal daemon handoff",
    });
    await handoff.release();
    if (action === "stop") return null;
    if (unit) {
      await execFile("systemctl", ["--user", "restart", "--", unit], {
        env: options.environment ?? process.env,
        timeout: 15_000,
      });
    } else {
      const client = await launchTerminalDaemon(options);
      await client.close();
    }
    const readyDeadline = Date.now() + 8_000;
    while (Date.now() < readyDeadline) {
      const ready = await inspectTerminalDaemon(options);
      if (ready.kind === "running") {
        if (
          status.kind === "running" &&
          ready.info.instanceId === status.info.instanceId
        )
          throw new Error("The terminal daemon was not replaced.");
        return ready.info;
      }
      await delay(75);
    }
    throw new Error(
      "The replacement terminal daemon has not become ready. Inspect terminal status.",
    );
  } finally {
    await control.release();
  }
}
