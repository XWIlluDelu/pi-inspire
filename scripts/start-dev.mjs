import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  portAvailable,
  stopManagedInstance,
} from "../server/instance-state.mjs";
import { npmInvocation } from "../server/npm-command.mjs";
import {
  isolatedProcessOptions,
  signalProcessTree,
} from "../server/process-tree.mjs";

const root = resolve(import.meta.dirname, "..");
const host = process.env.INSPIRE_HOST ?? "127.0.0.1";
const port = Number(process.env.INSPIRE_PORT ?? "4587");
if (
  !["127.0.0.1", "::1", "localhost"].includes(host) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
)
  throw new Error(
    "Development requires a loopback INSPIRE_HOST and valid INSPIRE_PORT",
  );
if (!(await portAvailable(host, port)))
  throw new Error(
    `Development Host port ${host}:${port} is in use; choose a separate INSPIRE_PORT`,
  );

const directory = await mkdtemp(join(tmpdir(), "inspire-dev-"));
const statePath = join(directory, "host.json");
const environment = {
  ...process.env,
  INSPIRE_TOKEN: randomBytes(32).toString("base64url"),
  INSPIRE_INSTALLATION_ROOT: root,
  INSPIRE_HOST: host,
  INSPIRE_PORT: String(port),
  INSPIRE_STATE_PATH: statePath,
  INSPIRE_STOP_REQUEST_PATH: join(directory, "stop-request"),
  INSPIRE_DEV_STATE_PATH: statePath,
  INSPIRE_QUIET: "1",
};
const invocation = npmInvocation(["run", "dev:servers"], {
  environment,
  cwd: root,
});
let child;
let stopping;
let childExited;
let interrupted = false;
const stop = () =>
  (stopping ??= (async () => {
    // Retire the actual Host first. Only then end the owned dev toolchain;
    // no name search, port kill or inherited daily-instance state is used.
    try {
      const result = await stopManagedInstance(
        statePath,
        { root, host, port },
        { timeoutMs: 10000 },
      );
      if (!["stopped", "absent", "stale"].includes(result.kind))
        throw new Error("Development Host cleanup was not confirmed");
    } finally {
      if (child) await signalProcessTree(child, "SIGKILL", { isolated: true });
    }
  })());
const onSignal = () => {
  interrupted = true;
  void stop().catch((error) => console.error(error.message));
};
try {
  child = spawn(invocation.command, invocation.args, {
    cwd: root,
    env: invocation.environment,
    stdio: "inherit",
    ...isolatedProcessOptions(),
  });
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  childExited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
  const code = await childExited;
  await stop();
  process.exitCode = interrupted ? 0 : code;
} finally {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  await stop();
  await childExited?.catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
