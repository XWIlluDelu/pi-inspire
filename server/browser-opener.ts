import { spawn, type SpawnOptions } from "node:child_process";

interface DetachedChild {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  unref(): void;
}

type SpawnDetached = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => DetachedChild;

/** Best-effort desktop integration: inability to find or start an opener must
 * never change the lifetime of the already-listening Host. */
export function openBrowser(
  url: string,
  onError: (error: Error) => void,
  platform = process.platform,
  spawnDetached: SpawnDetached = spawn as unknown as SpawnDetached,
): void {
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawnDetached(command, args, {
      detached: true,
      stdio: "ignore",
    });
    let reported = false;
    const report = (error: Error): void => {
      if (reported) return;
      reported = true;
      onError(error);
    };
    child.once("error", report);
    child.once("exit", (code, signal) => {
      if (code === 0) return;
      report(
        Object.assign(
          new Error(
            `Desktop browser opener ${signal ? `ended with ${signal}` : `exited with status ${code ?? "unknown"}`}`,
          ),
          { code: signal ?? (code === null ? "EXIT_UNKNOWN" : `EXIT_${code}`) },
        ),
      );
    });
    child.unref();
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
  }
}
