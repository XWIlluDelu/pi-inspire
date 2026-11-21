import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HostRestartBackend } from "./host-restart.js";
import { prepareHostRestart } from "./host-restart-preparation.js";
import { createLauncherRestartClient } from "./launcher-restart.mjs";
import type { RestartSubmission } from "./restart-submission.mjs";

export function hostRestartBackend(
  root: string,
  options: {
    enabled: boolean;
    systemdEnabled: boolean;
    restart: () => Promise<void>;
  },
): HostRestartBackend {
  const backend =
    options.enabled && process.send
      ? launcherRestartBackend(options.restart)
      : systemdRestartBackend(root, options.enabled && options.systemdEnabled);
  return { ...backend, prepare: () => prepareHostRestart(root) };
}

type RestartTransport = Omit<HostRestartBackend, "prepare">;

function launcherRestartBackend(restart: () => Promise<void>): RestartTransport {
  const launcher = createLauncherRestartClient(process);
  return {
    async inspect() {
      return { host: await launcher.inspect() };
    },
    async request(_scope, commit) {
      const result = await launcher.request(commit);
      if (result.kind === "issued") {
        // Let the controller publish submission before graceful shutdown.
        setImmediate(() => {
          void restart().catch((error) => {
            console.error(
              "Unable to complete launcher-owned Host restart",
              error,
            );
          });
        });
      }
      return result;
    },
  };
}

interface ServiceControl {
  inspectRestartTarget(
    root: string,
    invocationId: string,
  ): Promise<{ kind: string }>;
  submitSystemdRestart(
    root: string,
    plan: {
      invocationId: string;
      detached: boolean;
      commit: () => boolean | Promise<boolean>;
    },
  ): Promise<RestartSubmission>;
}

export function systemdRestartBackend(
  root: string,
  enabled: boolean,
): RestartTransport {
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
      return { host: available };
    },
    async request(_scope, commit) {
      if (!supported) return { kind: "not-issued", reason: "unsupported" };
      return (await control()).submitSystemdRestart(root, {
        invocationId,
        detached: true,
        commit,
      });
    },
  };
}
