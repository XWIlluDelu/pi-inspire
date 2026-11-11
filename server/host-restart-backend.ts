import type { HostRestartBackend } from "./host-restart.js";
import { prepareHostRestart } from "./host-restart-preparation.js";
import { systemdRestartBackend } from "./host-restart-systemd.js";
import { createLauncherRestartClient } from "./launcher-restart.mjs";

export function hostRestartBackend(
  root: string,
  options: {
    enabled: boolean;
    systemdEnabled: boolean;
    restart: () => Promise<void>;
  },
): HostRestartBackend {
  if (!options.enabled || !process.send)
    return systemdRestartBackend(
      root,
      options.enabled && options.systemdEnabled,
    );
  const launcher = createLauncherRestartClient(process);
  return {
    async inspect() {
      return { host: await launcher.inspect(), all: false };
    },
    prepare: () => prepareHostRestart(root),
    async request(all, commit) {
      if (all) return { code: 1, issued: false };
      const result = await launcher.request(commit);
      if (result.issued) {
        // Let the controller publish submission before graceful shutdown.
        setImmediate(() => {
          void options.restart().catch((error) => {
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
