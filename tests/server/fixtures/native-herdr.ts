import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { AttachmentStore } from "../../../server/attachments.js";
import { HerdrClient } from "../../../server/herdr-client.js";
import { HerdrEnhancement } from "../../../server/herdr-enhancement.js";
import { HerdrWorkerObserver } from "../../../server/herdr-worker-observer.js";
import { HerdrWorkerRegistry } from "../../../server/herdr-worker-registry.js";
import { getAgentDir, piInstallation } from "../../../server/pi-runtime.js";
import { RuntimeController } from "../../../server/runtime.js";
import { SessionCatalog } from "../../../server/session-catalog.js";

const exec = promisify(execFile);
const reporter = join(getAgentDir(), "extensions", "herdr-agent-state.ts");
export const nativeHerdrAvailable =
  process.platform === "linux" &&
  (await Promise.all([exec("herdr", ["--version"]), access(reporter)]).then(
    () => true,
    () => false,
  ));

/** Real native Pi and public Herdr control, isolated from personal terminals.
 * The model fixture replies locally; no provider credentials or network work. */
export async function nativeHerdrFixture(
  options: { streamDelayMs?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "inspire-native-pi-"));
  const sessionName = `inspire-test-${randomUUID().slice(0, 8)}`;
  const sessionId = randomUUID();
  const sessionFile = join(root, `${sessionId}.jsonl`);
  const agentDir = join(root, "agent");
  const client = new HerdrClient({ session: sessionName });
  const observer = new HerdrWorkerObserver({ client });
  const enhancement = new HerdrEnhancement({
    enabled: true,
    client,
    registry: new HerdrWorkerRegistry(join(root, "leases")),
  });
  const store = new AttachmentStore(join(root, "attachments"), null, {
    sweepIntervalMs: 0,
  });
  const catalog: SessionCatalog = new (class extends SessionCatalog {
    override async sessionDirectories() {
      return [root];
    }
  })(root);
  const runtimes: RuntimeController[] = [];
  async function close() {
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    await store.close();
    await enhancement.close();
    // Only this disposable named server belongs to this fixture.
    await exec("herdr", ["--session", sessionName, "server", "stop"]).catch(
      () => undefined,
    );
    await exec("herdr", ["session", "delete", sessionName]).catch(
      () => undefined,
    );
    await rm(root, { recursive: true, force: true });
  }
  try {
    await mkdir(agentDir);
    await exec("git", ["init", "--quiet", root]);
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProjectTrust: "never",
        enableInstallTelemetry: false,
        packages: [],
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
        compaction: { enabled: false },
        cacheWarming: "off",
        retry: { enabled: false },
      }),
    );
    await writeFile(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: sessionId,
          cwd: root,
          timestamp: new Date().toISOString(),
        },
        {
          type: "session_info",
          id: "native-name",
          parentId: null,
          name: "Native Pi continuity",
          timestamp: new Date().toISOString(),
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const pane = await client.createWorkerPane(root, "Native Pi test", [
      "/usr/bin/env",
      `PI_CODING_AGENT_DIR=${agentDir}`,
      "PI_OFFLINE=1",
      "PI_SKIP_VERSION_CHECK=1",
      `INSPIRE_MODEL_FIXTURE_STREAM_DELAY_MS=${options.streamDelayMs ?? 0}`,
      process.execPath,
      piInstallation.cliPath,
      "--session",
      sessionFile,
      "--provider",
      "global-native",
      "--model",
      "a",
      "--no-extensions",
      "-e",
      reporter,
      "-e",
      resolve("tests/fixtures/pi-model-workflow-extension.ts"),
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
    ]);
    let writer: Awaited<ReturnType<typeof observer.findNativeWriter>> = null;
    const deadline = Date.now() + 15_000;
    while (!writer && Date.now() < deadline) {
      writer = await observer.findNativeWriter(sessionId, sessionFile);
      if (!writer) await delay(100);
    }
    if (!writer) {
      const terminal = await exec("herdr", [
        "--session",
        sessionName,
        "pane",
        "read",
        pane.paneId,
        "--source",
        "recent-unwrapped",
        "--lines",
        "80",
      ]).catch(String);
      throw new Error(
        `Native Pi ${piInstallation.version} did not become available: ${JSON.stringify(terminal)}`,
      );
    }
    return {
      root,
      sessionId,
      sessionFile,
      client,
      observer,
      pane,
      store,
      catalog,
      originalPid: writer.pid,
      readHistory: () => readFile(sessionFile, "utf8"),
      makeRuntime() {
        const runtime = new RuntimeController(catalog, store, () => {
          throw new Error("An existing Pi must not launch a second worker");
        }).setExternalSessionConnector((id, file) =>
          enhancement.connectExternalSession(id, file),
        );
        runtimes.push(runtime);
        return runtime;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
