import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HostRestartBackend } from "./host-restart.js";
import { prepareHostRestart } from "./host-restart-preparation.js";

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
      const available =
        supported &&
        (await (await control()).inspectBrowserRestart(root, { invocationId }))
          .kind === "managed";
      return { host: available, all: available };
    },
    prepare: () => prepareHostRestart(root),
    async request(all, commit) {
      if (!supported) return { issued: false, code: 1 };
      return (await control()).requestBrowserRestart(root, all, commit, {
        invocationId,
      });
    },
  };
}
