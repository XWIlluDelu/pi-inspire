// Holds one Pi RPC worker's pipes for the Host. Bytes pass through unchanged.
// Pi's RPC mode exits when stdin ends, so after the Host sends `detach` on the
// control channel (fd 3) the keeper keeps Pi's stdin open when the Host goes
// away: the worker and its running work survive a Host-only restart. Without
// that message, losing the Host ends Pi's input exactly as a direct child.
// Usage: node pi-worker-keeper.mjs <executable> [args...]
import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { createPiRpcUiRelay } from "./pi-rpc-ui-relay.mjs";

const [executable, ...args] = process.argv.slice(2);
if (!executable) {
  process.stderr.write("pi-worker-keeper: an executable is required\n");
  process.exit(2);
}

const ui = await createPiRpcUiRelay();
const child = spawn(executable, args, {
  env: ui
    ? { ...process.env, PI_ATTACH_CONTROL_RPC_UI: ui.environment }
    : process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
if (ui) {
  ui.attach(child);
  process.stdin.on("data", ui.observeInput);
}
let detached = false;
let hostGone = false;

const forget = () => {
  // Keep draining Pi so its writes never block once nobody reads them.
  hostGone = true;
  child.stdout.unpipe(process.stdout);
  child.stderr.unpipe(process.stderr);
  child.stdout.resume();
  child.stderr.resume();
};

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdin.pipe(child.stdin, { end: false });
process.stdin.on("end", () => {
  if (detached) forget();
  else child.stdin.end();
});
for (const stream of [process.stdout, process.stderr])
  stream.on("error", () => {
    if (detached) forget();
  });
child.stdin.on("error", () => {});

try {
  // A pipe handle, not a file stream: a blocking file read would hold up exit.
  const control = new Socket({ fd: 3, readable: true, writable: false });
  control.setEncoding("utf8");
  control.on("data", (chunk) => {
    if (chunk.includes("detach")) detached = true;
  });
  control.on("error", () => {});
  control.unref();
} catch {
  // Without a control channel the keeper behaves as a plain direct child.
}

child.once("error", () => {
  void Promise.resolve(ui?.close()).finally(() => process.exit(1));
});
child.once("exit", async (code, signal) => {
  await ui?.close();
  if (hostGone || !signal) process.exit(code ?? 1);
  process.kill(process.pid, signal);
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.on(signal, () => {
    // A preserved worker ignores the hang-up of a departed Host.
    if (signal === "SIGHUP" && detached) return;
    child.kill(signal);
  });
