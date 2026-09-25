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
import { assertHerdrBridgeGroup } from "./herdr-process-group.js";

async function run(): Promise<void> {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3)
    throw new Error("A private launch file is required");
  await assertHerdrBridgeGroup();
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
  const killGroup = (signal: NodeJS.Signals) =>
    process.kill(-process.pid, signal);
  const stop = () => {
    if (stopping) return;
    stopping = true;
    rpc.destroy();
    stderr.destroy();
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
      killGroup("SIGKILL");
      return;
    }
    // We deliberately share the pane bridge's group, not a detached child's
    // group. The Host can then fence every writer even if the bridge dies
    // between spawn() and reporting the Pi PID.
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), 1_500);
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
    child.once("exit", () => killGroup("SIGKILL"));
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
