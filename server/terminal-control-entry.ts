import {
  controlTerminalDaemon,
  inspectTerminalDaemon,
} from "./terminal-daemon-control.js";

async function main(): Promise<void> {
  const [action, ...args] = process.argv.slice(2);
  if (["-h", "--help", "help"].includes(action ?? "")) {
    console.log(
      "Use: inspire terminal <status|stop|restart> [--force]\nTargets this installation/Host/port and configured terminal paths. --force confirms ending all running project terminals; it does not bypass authentication or kill unknown PIDs.",
    );
    return;
  }
  if (
    !["status", "stop", "restart"].includes(action ?? "") ||
    (args.length &&
      !(args.length === 1 && args[0] === "--force" && action !== "status"))
  )
    throw Object.assign(
      new Error("Use: inspire terminal <status|stop|restart> [--force]"),
      { exitCode: 64 },
    );
  const options = {
    root: process.cwd(),
    host: process.env.INSPIRE_HOST ?? "127.0.0.1",
    port: Number(process.env.INSPIRE_PORT ?? "4587"),
  };
  if (action === "status") {
    const result = await inspectTerminalDaemon(options);
    if (result.kind === "unavailable") throw new Error(result.message);
    console.log(
      result.kind === "stopped"
        ? "No terminal daemon endpoint is listening."
        : `Terminal daemon ${result.info.pid} (${result.info.instanceId}): ${result.info.stopping ? "stopping" : "running"}, ${result.info.runningTerminals} live terminal(s).`,
    );
  } else {
    const result = await controlTerminalDaemon(
      action as "stop" | "restart",
      options,
      args[0] === "--force",
    );
    console.log(
      result
        ? `Restarted terminal daemon ${result.pid}. Saved tabs are exited; commands were not rerun.`
        : "The terminal daemon is stopped. The Host was not restarted.",
    );
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = Number(error?.exitCode) || 1;
});
