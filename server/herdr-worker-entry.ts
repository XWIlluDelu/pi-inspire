import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import {
  HERDR_BRIDGE_VERSION,
  herdrLaunchGrantSchema,
  herdrLaunchTicketSchema,
  readHerdrBridgeRecord,
  writeHerdrBridgeRecord,
} from "./herdr-bridge-protocol.js";
import {
  captureHerdrBridgeGroup,
  stopHerdrProcessGroup,
} from "./herdr-process-group.js";

async function run(): Promise<void> {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3)
    throw new Error("A private launch file is required");
  const group = await captureHerdrBridgeGroup();
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o077) !== 0 ||
    info.size > 8_192
  )
    throw new Error("Invalid private launch file");
  const ticket = herdrLaunchTicketSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  await rm(path);

  const rpc = connect(ticket.address);
  const stderr = connect(ticket.address);
  let child: ChildProcessWithoutNullStreams | null = null;
  let stopping = false;
  const terminate = (graceful: boolean) => {
    void stopHerdrProcessGroup(group, graceful, () => {}).catch(() => {
      process.stderr.write("Inspire worker scope could not be stopped\n");
      process.exitCode = 1;
    });
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    rpc.destroy();
    stderr.destroy();
    // The same kernel-owned tree is available here after Host loss and to the
    // Host after bridge loss. Pi's detached Bash tools remain in this scope.
    const graceful =
      !!child?.pid && child.exitCode === null && child.signalCode === null;
    terminate(graceful);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  for (const socket of [rpc, stderr]) {
    socket.on("error", stop);
    socket.on("close", stop);
  }

  try {
    writeHerdrBridgeRecord(rpc, {
      version: HERDR_BRIDGE_VERSION,
      token: ticket.token,
      channel: "rpc",
      pid: process.pid,
    });
    writeHerdrBridgeRecord(stderr, {
      version: HERDR_BRIDGE_VERSION,
      token: ticket.token,
      channel: "stderr",
      pid: process.pid,
    });
    const grant = herdrLaunchGrantSchema.parse(
      await readHerdrBridgeRecord(rpc, AbortSignal.timeout(60_000)),
    );
    if (stopping) return;
    const environment: NodeJS.ProcessEnv = { ...grant.env };
    for (const key of Object.keys(environment))
      if (key.startsWith("HERDR_") && key !== "HERDR_BIN")
        delete environment[key];
    for (const [key, value] of Object.entries(process.env))
      if (key.startsWith("HERDR_") && key !== "HERDR_BIN")
        environment[key] = value;

    child = spawn(grant.executable, grant.args, {
      cwd: grant.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      // The verified bridge is the process-group leader. Never detach Pi.
      detached: false,
    });
    child.once("error", stop);
    // An orderly Pi exit ends the grace period immediately. A killed Pi cannot
    // run its own detached-child cleanup, so both cases still reap the scope.
    child.once("exit", () => terminate(false));
    for (const stream of [child.stdin, child.stdout, child.stderr])
      stream.on("error", stop);
    if (!child.pid) {
      stop();
      return;
    }
    writeHerdrBridgeRecord(rpc, { pid: child.pid });
    child.stderr.pipe(stderr);
    child.stdout.pipe(rpc);
    rpc.pipe(child.stdin);
    process.stdout.write("INSΠRE Pi worker\n");
  } catch {
    process.stderr.write("Inspire worker bridge could not start Pi\n");
    stop();
  }
}

void run().catch(() => {
  process.stderr.write(
    "Inspire worker bridge could not open its private launch\n",
  );
  process.exitCode = 1;
});
