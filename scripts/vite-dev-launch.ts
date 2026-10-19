import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import {
  inspectInstance,
  instanceLaunchUrl,
} from "../server/instance-state.mjs";

/** Runs only for the coordinated source-development entry. Vite owns the
 * listener before any grant/opener is issued; readiness proves the private
 * Host key and never sends that reusable key to a guessed port. */
export function developmentLaunch(environment = process.env): Plugin {
  return {
    name: "inspire-development-launch",
    configureServer(server: ViteDevServer) {
      const statePath = environment.INSPIRE_DEV_STATE_PATH;
      if (!statePath || !server.httpServer) return;
      let closed = false;
      server.httpServer.once("close", () => {
        closed = true;
      });
      const launch = async (explicit = false) => {
        const deadline = Date.now() + 30_000;
        while (!closed && Date.now() < deadline) {
          const owned = await inspectInstance(
            statePath,
            {
              root: resolve(server.config.root),
              host: environment.INSPIRE_HOST ?? "127.0.0.1",
              port: Number(environment.INSPIRE_PORT ?? "4587"),
              mock: environment.INSPIRE_MOCK === "1",
            },
            { healthTimeoutMs: 1000 },
          );
          if (
            owned.kind === "healthy" &&
            owned.state.token === environment.INSPIRE_TOKEN
          ) {
            const address = server.httpServer?.address() as AddressInfo | null;
            if (!address || closed || !server.httpServer?.listening) return;
            const hostname =
              address.family === "IPv6"
                ? `[${address.address}]`
                : address.address;
            const origin = new URL(`http://${hostname}:${address.port}`).origin;
            const url = await instanceLaunchUrl(owned.state, origin);
            if (!url)
              throw new Error(
                "The development Host did not prove a matching pairing link",
              );
            if (closed || !server.httpServer?.listening) return;
            server.config.logger.info(`\n  INSΠRE development: ${url}\n`);
            if (explicit || environment.INSPIRE_OPEN !== "0") {
              server.config.server.open = url;
              server.openBrowser();
            }
            return;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        if (!closed)
          throw new Error("The private development Host did not become ready");
      };
      server.httpServer.once("listening", () => {
        server.bindCLIShortcuts({
          customShortcuts: [
            {
              key: "o",
              description: "open a fresh paired development page",
              action: () => launch(true),
            },
          ],
        });
        void launch().catch(async (error: unknown) => {
          server.config.logger.error(
            error instanceof Error
              ? error.message
              : "Development startup failed",
          );
          await server.close();
          process.exit(1);
        });
      });
    },
  };
}
