import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HostRestartBackend } from "./host-restart.js";
import { prepareHostRestart } from "./host-restart-preparation.js";
import { stopAllPiProcesses, supportsGlobalPiStop } from "./pi-processes.mjs";

interface ServiceControl {
  inspectBrowserRestart(
    root: string,
    options: { invocationId: string },
  ): Promise<{ kind: string }>;
  requestBrowserRestart(
    root: string,
    all: boolean,
    commit: () => boolean | Promise<boolean>,
    options: { invocationId: string },
  ): Promise<{ code: number; issued?: boolean }>;
}

export function systemdRestartBackend(
  root: string,
  enabled: boolean,
  options: {
    includeHerdr?: boolean;
    stopPi?: (options: { includeHerdr: boolean }) => Promise<void>;
  } = {},
): HostRestartBackend {
  const includeHerdr = options.includeHerdr === true;
  const stopPi = options.stopPi ?? stopAllPiProcesses;
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
      const available =
        supported &&
        (await (await control()).inspectBrowserRestart(root, { invocationId }))
          .kind === "managed";
      return {
        host: available,
        all: available,
        allPi: available && supportsGlobalPiStop(),
        includeHerdr,
      };
    },
    prepare: () => prepareHostRestart(root),
    async request(scope, commit) {
      if (!supported || (scope === "all-pi" && !supportsGlobalPiStop()))
        return { issued: false, code: 1 };
      let stopError: string | undefined;
      const result = await (await control()).requestBrowserRestart(
        root,
        scope === "all" || scope === "all-pi",
        async () => {
          if (!(await commit())) return false;
          if (scope === "all-pi") {
            try {
              await stopPi({ includeHerdr });
            } catch (error) {
              stopError = `Pi shutdown failed. Inspire was not restarted. ${error instanceof Error ? error.message : String(error)}`;
              return false;
            }
          }
          return true;
        },
        { invocationId },
      );
      return stopError ? { ...result, error: stopError } : result;
    },
  };
}
