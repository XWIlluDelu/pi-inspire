import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HostRestartBackend } from "./host-restart.js";
import { prepareHostRestart } from "./host-restart-preparation.js";
import { stopAllPiProcesses, supportsGlobalPiStop } from "./pi-processes.mjs";

interface ServiceControl {
  inspectRestartTarget(
    root: string,
    invocationId: string,
  ): Promise<{ kind: string }>;
  submitSystemdRestart(
    root: string,
    plan: {
      invocationId: string;
      terminals: boolean;
      detached: boolean;
      commit: () => boolean | Promise<boolean>;
      beforeRestart?: () => Promise<void>;
    },
  ): Promise<
    | { kind: "issued" }
    | { kind: "unconfirmed" }
    | { kind: "not-issued"; reason: string; error?: unknown }
  >;
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
        (await (await control()).inspectRestartTarget(root, invocationId))
          .kind === "managed";
      return {
        host: available,
        allPi: available && supportsGlobalPiStop(),
        includeHerdr,
      };
    },
    prepare: () => prepareHostRestart(root),
    async request(scope, commit) {
      if (!supported || (scope === "all-pi" && !supportsGlobalPiStop()))
        return { issued: false, code: 1 };
      const result = await (await control()).submitSystemdRestart(root, {
        invocationId,
        terminals: scope === "all-pi",
        detached: true,
        commit,
        beforeRestart:
          scope === "all-pi"
            ? async () => {
                try {
                  await stopPi({ includeHerdr });
                } catch (error) {
                  throw new Error(
                    `Pi shutdown failed. Inspire was not restarted. ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              }
            : undefined,
      });
      if (result.kind === "issued") return { code: 0, issued: true };
      if (result.kind === "unconfirmed") return { code: 1 };
      return {
        code: 1,
        issued: false,
        ...(result.error instanceof Error
          ? { error: result.error.message }
          : {}),
      };
    },
  };
}
