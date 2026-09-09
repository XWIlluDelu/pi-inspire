import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { HostRestartBackend } from "./host-restart.js";

interface ServiceControl {
  inspectBrowserRestart(
    root: string,
    options: { invocationId: string },
  ): Promise<{ kind: string }>;
  requestBrowserRestart(
    root: string,
    all: boolean,
    commit: () => boolean,
    options: { invocationId: string },
  ): Promise<{ code: number; issued?: boolean }>;
}

export function systemdRestartBackend(
  root: string,
  enabled: boolean,
): HostRestartBackend {
  const invocationId = process.env.INVOCATION_ID ?? "";
  const supported =
    enabled &&
    process.platform === "linux" &&
    /^[a-f0-9]{32}$/u.test(invocationId);
  const control = (): Promise<ServiceControl> =>
    import(
      pathToFileURL(join(root, "deploy", "systemd", "control.mjs")).href
    ) as Promise<ServiceControl>;
  return {
    async inspect() {
      if (!supported) return false;
      return (
        (await (await control()).inspectBrowserRestart(root, { invocationId }))
          .kind === "managed"
      );
    },
    prepare() {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [join(root, "inspire.mjs"), "prepare-restart"],
          {
            cwd: root,
            env: { ...process.env, INSPIRE_OPEN: "0", INSPIRE_QUIET: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let detail = "";
        const collect = (chunk: Buffer) => {
          detail = (detail + chunk.toString("utf8")).slice(-4_000);
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.once("error", () =>
          reject(
            new Error(
              "Restart preparation could not start. The Host was not stopped.",
            ),
          ),
        );
        child.once("close", (code) => {
          if (code === 0) return resolve();
          // Bounded compiler/import diagnostics only; preparation never opens
          // a session or runs extensions. No credentials or request bodies added.
          const reason = stripVTControlCharacters(detail).trim();
          reject(
            new Error(
              `Restart preparation failed. The Host was not stopped.${reason ? `\n${reason}` : ""}`,
            ),
          );
        });
      });
    },
    async request(all, commit) {
      if (!supported) return { issued: false, code: 1 };
      return (await control()).requestBrowserRestart(root, all, commit, {
        invocationId,
      });
    },
  };
}
