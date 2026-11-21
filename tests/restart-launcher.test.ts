import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTANCE_STATE_VERSION,
  type InstanceState,
  processStartIdentity,
  writeInstanceState,
} from "../server/instance-state.mjs";
import {
  inspireRuntimeDirectory,
  installationKey,
} from "../server/platform-paths.mjs";
import {
  installSystemdManager,
  preparePackagedLauncher,
} from "./fixtures/packaged-launcher.mjs";
import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "./server/fixtures/host-api.js";
import { isolatedTestEnvironment } from "./server/fixtures/isolated-environment.js";

let root: string;
let host: Awaited<ReturnType<typeof hostApiFixture>> | undefined;
afterEach(async () => {
  if (host) await closeHostApiFixture(host);
  host = undefined;
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "inspire-restart-launcher-"));
  await preparePackagedLauncher(root);
  const logPath = await installSystemdManager(root);
  await writeFile(
    join(root, "build/server/restart-preflight.js"),
    `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.FIXTURE_LOG, 'preflight\\n'); process.exit(process.env.FIXTURE_PREFLIGHT_FAIL ? 1 : 0);`,
  );
  const env = isolatedTestEnvironment(root, {
    PATH: [
      join(root, "bin"),
      dirname(process.execPath),
      "/usr/bin",
      "/bin",
    ].join(delimiter),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    FIXTURE_ROOT: root,
    FIXTURE_LOG: logPath,
    INSPIRE_OPEN: "0",
  });
  const command = (args: string[]) => [join(root, "inspire.mjs"), ...args];
  const options = { env, encoding: "utf8" as const, timeout: 15_000 };
  const log = () => readFile(logPath, "utf8");
  return {
    root,
    env,
    run: (args: string[]) =>
      execFileSync(process.execPath, command(args), options),
    runAsync: (args: string[]) =>
      promisify(execFile)(process.execPath, command(args), options),
    async runningHost({ confirmExit = true, ready = true } = {}) {
      let state: InstanceState;
      host = await hostApiFixture({
        instanceState: () => (ready ? state : null),
      });
      state = {
        schemaVersion: INSTANCE_STATE_VERSION,
        root,
        pid: process.pid,
        processStartTime: await processStartIdentity(process.pid),
        startedAt: new Date().toISOString(),
        systemdInvocationId: "a".repeat(32),
        host: "127.0.0.1",
        port: Number(new URL(host.baseUrl).port),
        token,
      };
      const statePath = join(
        inspireRuntimeDirectory({ environment: env }),
        `${installationKey(root, "127.0.0.1", 4587)}.json`,
      );
      await writeInstanceState(statePath, state);

      // The CLI addresses the default service; the real test HTTP Host listens
      // on an ephemeral port. Route readiness there and simulate manager-confirmed exit.
      const entry = join(root, "build", "server", "instance-state.mjs");
      await rename(entry, join(dirname(entry), "instance-state.original.mjs"));
      await writeFile(
        entry,
        `
        import { appendFile, access } from "node:fs/promises";
        import { inspectInstance as inspect } from "./instance-state.original.mjs";
        export * from "./instance-state.original.mjs";
        export async function inspectInstance(path, expected, options) {
          await appendFile(process.env.FIXTURE_LOG, "inspect owner\\n");
          return inspect(path, { ...expected, port: ${state.port} }, options);
        }
        export async function observeProcessExit() {
          return ${confirmExit} && access(process.env.FIXTURE_ROOT + "/old-host-exited").then(() => true, () => false);
        }
      `,
      );
    },
    log,
    mutations: async () =>
      (await log()).match(/^--user (?:start|stop|restart) .*$/gmu) ?? [],
  };
}

describe.runIf(process.platform === "linux")(
  "prepared launcher restarts (isolated service fixture)",
  () => {
    it("installs readiness-gated units and delegates only default Host lifecycles", async () => {
      const f = await fixture();
      f.run(["service", "install-host"]);
      const unit = (name: string) =>
        readFile(join(f.env.XDG_CONFIG_HOME!, "systemd/user", name), "utf8");
      const host = await unit("inspire-host.service");
      expect(host).toContain(`ExecStartPost=${f.root}/inspire wait-ready`);
      expect(host).toContain("Wants=network-online.target");
      expect(host).toContain("Environment=INSPIRE_ENVIRONMENT=shell");
      expect(host).not.toContain("Environment=NODE_ENV=");
      expect(host).not.toContain(f.env.PATH);

      await writeFile(join(f.root, "old-host-exited"), "");
      f.run([]);
      expect(f.run(["service", "status-host"])).toContain(
        "INSΠRE system service is running (enabled).",
      );
      expect(() => f.run(["status"])).toThrow(/Host is not reachable/u);
      f.run(["stop"]);
      f.run(["service", "enable-host"]);
      f.run(["service", "disable-host"]);
      const log = await f.log();
      expect(log.match(/^--user (?:start|stop|enable|disable) .*$/gmu)).toEqual(
        [
          "--user start inspire-host.service",
          "--user stop inspire-host.service",
          "--user enable --now inspire-host.service",
          "--user disable --now inspire-idle-maintenance-restart.timer",
          "--user disable --now inspire-host.service",
        ],
      );
      f.env.FIXTURE_OUTDATED = "1";
      expect(() => f.run(["status"])).toThrow(/unit is outdated/u);
      f.env.INSPIRE_PORT = "4587oops";
      expect(() => f.run(["status"])).toThrow(/valid TCP port/u);
      f.env.INSPIRE_PORT = "4589";
      expect(() => f.run(["status"])).toThrow(/INSΠRE is not running/u);
    }, 30_000);

    it("admits only supported callers and scopes before preparing a service restart", async () => {
      const f = await fixture();
      expect(() => f.run(["restart", "--host-only"])).toThrow(
        /Use: inspire restart/,
      );
      expect(() => f.run(["restart", "--all"])).toThrow(/Use: inspire restart/);
      f.env.INSPIRE_TERMINAL_ID = "project-terminal";
      expect(() => f.run(["restart"])).toThrow(/external OS terminal/);
      expect(await f.log()).not.toMatch(/preflight/);
      expect(await f.mutations()).toEqual([]);

      delete f.env.INSPIRE_TERMINAL_ID;
      f.env.FIXTURE_PREFLIGHT_FAIL = "1";
      expect(() => f.run(["restart"])).toThrow(/running Host was not stopped/);
      expect(await f.mutations()).toEqual([]);
      expect(await f.log()).toContain("preflight\n");
      delete f.env.FIXTURE_PREFLIGHT_FAIL;
      expect(f.run(["restart"])).toContain("Restarted INSΠRE Host.");
      expect(await f.mutations()).toEqual([
        "--user restart inspire-host.service",
      ]);
      expect(await f.log()).toMatch(
        /preflight\n[\s\S]*restart inspire-host.service/,
      );
    });
  },
);
