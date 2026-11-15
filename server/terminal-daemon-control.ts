import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { acquireFileLock } from "./file-lock.mjs";
import { observeProcessExit, processStartIdentity } from "./instance-state.mjs";
import { TerminalDaemonClient } from "./terminal-daemon-client.js";
import {
  resolveTerminalDaemonConfiguration,
  sameTerminalDaemonConfiguration,
  type TerminalDaemonConfiguration,
  type TerminalDaemonInfo,
  type TerminalDaemonLaunchOptions,
} from "./terminal-daemon-configuration.js";
import {
  launchTerminalDaemon,
  waitForTerminalDaemon,
} from "./terminal-daemon-launcher.js";
import { TERMINAL_DAEMON_PROTOCOL_VERSION } from "./terminal-daemon-protocol.js";
import { addressAcceptsConnections } from "./terminal-daemon-socket.js";
import { readTerminalDaemonSecret } from "./terminal-daemon-tls.js";
import { TerminalServiceError } from "./terminal-service.js";
import { prepareTerminalStateDirectory } from "./terminal-state-store.js";

const execFile = promisify(execFileCallback);
const STOP_TIMEOUT_MS = 20_000;
const CONNECTION_GUIDANCE =
  "A terminal endpoint is listening, but its authenticated connection could not be verified. Existing terminal processes were left running. Inspect the owning service before replacing it.";

type TerminalDaemonStatus =
  | { kind: "running"; info: TerminalDaemonInfo }
  | { kind: "stopped" }
  | { kind: "unavailable"; message: string };

function validInfo(
  info: TerminalDaemonInfo,
  config: TerminalDaemonConfiguration,
): boolean {
  return (
    info?.protocolVersion === TERMINAL_DAEMON_PROTOCOL_VERSION &&
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

async function withTerminalClient<T>(
  config: TerminalDaemonConfiguration,
  operation: (client: TerminalDaemonClient) => Promise<T>,
): Promise<T> {
  const client = new TerminalDaemonClient(
    config.address,
    await readTerminalDaemonSecret(config.tokenPath),
  );
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

async function verifiedDaemonInfo(
  client: TerminalDaemonClient,
  config: TerminalDaemonConfiguration,
): Promise<TerminalDaemonInfo> {
  const info = await client.daemonInfo();
  if (!validInfo(info, config))
    throw new TerminalServiceError(
      "terminal_scope_mismatch",
      409,
      "The authenticated terminal endpoint belongs to a different instance.",
    );
  if ((await processStartIdentity(info.pid)) !== info.processStartTime)
    throw new TerminalServiceError(
      "terminal_scope_mismatch",
      409,
      "The terminal daemon process identity changed; inspect it again.",
    );
  return info;
}

export async function inspectTerminalDaemon(
  options: TerminalDaemonLaunchOptions,
): Promise<TerminalDaemonStatus> {
  const config = resolveTerminalDaemonConfiguration(options);
  try {
    const info = await withTerminalClient(config, (client) =>
      verifiedDaemonInfo(client, config),
    );
    return { kind: "running", info };
  } catch (error) {
    // A verified foreign owner is not absence, even if it stopped listening
    // after its response. Never use that error as replacement authority.
    if (
      error instanceof TerminalServiceError &&
      error.code === "terminal_scope_mismatch"
    )
      return { kind: "unavailable", message: error.message };
    if (await addressAcceptsConnections(config.address))
      return {
        kind: "unavailable",
        message: CONNECTION_GUIDANCE,
      };
    // A missing listener is not proof of exit. A control request keeps its
    // captured process identity until confirmed below; status grants no stop.
    return { kind: "stopped" };
  }
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
      const { instanceId } = status.info;
      try {
        await withTerminalClient(config, (client) =>
          client.shutdownDaemon(instanceId, force),
        );
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
      }
      if (!(await observeProcessExit(status.info, STOP_TIMEOUT_MS)))
        throw new Error(
          "Terminal shutdown is unconfirmed. No replacement was started; run terminal status before retrying.",
        );
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
    const replacement = (info: TerminalDaemonInfo) => {
      if (
        status.kind === "running" &&
        info.instanceId === status.info.instanceId
      )
        throw new Error("The terminal daemon was not replaced.");
      return info;
    };
    if (!unit) {
      const client = await launchTerminalDaemon(options);
      try {
        return replacement(await verifiedDaemonInfo(client, config));
      } finally {
        await client.close();
      }
    }
    await execFile("systemctl", ["--user", "restart", "--", unit], {
      env: options.environment ?? process.env,
      timeout: 15_000,
    });
    const ready = await waitForTerminalDaemon(async () => {
      const state = await inspectTerminalDaemon(options);
      return state.kind === "running" ? state.info : undefined;
    });
    if (ready) return replacement(ready);
    throw new Error(
      "The replacement terminal daemon has not become ready. Inspect terminal status.",
    );
  } finally {
    await control.release();
  }
}
