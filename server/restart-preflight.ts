import { resolve } from "node:path";
import { resolvePiInstallation } from "./pi-installation.js";

// Load the next Host's runtime modules without binding a port, opening a Pi
// session, running extensions, or attaching to the daily terminal service.
await Promise.all([
  import("./app.js"),
  import("./runtime.js"),
  import("./terminal-daemon-server.js"),
  import("./terminal-session-manager.js"),
]);
if (process.env.INSPIRE_MOCK !== "1")
  await resolvePiInstallation({ installationRoot: resolve(process.cwd()) });
console.log("Restart preparation passed.");
