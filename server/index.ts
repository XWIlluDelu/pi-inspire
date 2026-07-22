import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AttachmentStore } from "./attachments.js";
import { createInspireServer } from "./app.js";
import { MockCatalog, MockRuntime } from "./mock.js";
import { PreferencesStore } from "./preferences.js";
import { ResourceStore } from "./resources.js";
import { RuntimeController, type RuntimeLike } from "./runtime.js";
import { SessionCatalog, type SessionCatalogLike } from "./session-catalog.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piPackage = JSON.parse(await readFile(join(dirname(dirname(piEntry)), "package.json"), "utf8")) as { version: string };

const host = process.env.INSPIRE_HOST ?? "127.0.0.1";
if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
  throw new Error("insπre binds to loopback only in the local release");
}
const port = Number.parseInt(process.env.INSPIRE_PORT ?? "4587", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("INSPIRE_PORT must be a valid TCP port");
const token = process.env.INSPIRE_TOKEN ?? randomBytes(32).toString("base64url");
const mock = process.env.INSPIRE_MOCK === "1";

const attachments = new AttachmentStore();
let catalog: SessionCatalogLike;
let runtime: RuntimeLike;
if (mock) {
  catalog = new MockCatalog();
  runtime = new MockRuntime();
} else {
  catalog = new SessionCatalog(process.cwd());
  runtime = new RuntimeController(catalog, attachments);
}
const preferences = new PreferencesStore(
  process.env.INSPIRE_PREFERENCES_PATH || undefined,
);
const resources = new ResourceStore();
const application = createInspireServer({
  token,
  runtime,
  catalog,
  attachments,
  preferences,
  resources,
  mock,
  version: packageJson.version,
  piVersion: piPackage.version,
  distDir: join(root, "dist"),
});

application.server.listen(port, host, () => {
  const displayHost = host === "::1" ? "[::1]" : host;
  const url = `http://${displayHost}:${port}/?token=${token}`;
  console.log(`\n  insπre ${packageJson.version}${mock ? " (mock)" : ""}`);
  console.log(`  ${url}\n`);
  if (process.env.INSPIRE_OPEN === "1") {
    void import("node:child_process").then(({ spawn }) => {
      const opener =
        process.platform === "darwin"
          ? ["open", [url]]
          : process.platform === "win32"
            ? ["cmd", ["/c", "start", "", url]]
            : ["xdg-open", [url]];
      spawn(opener[0] as string, opener[1] as string[], {
        detached: true,
        stdio: "ignore",
      }).unref();
    });
  }
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down after ${signal}…`);
  await application.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection", error);
});
