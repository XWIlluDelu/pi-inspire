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

const directories: string[] = [];
const closeServers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closeServers.splice(0)) await close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(fail: boolean) {
  const root = await mkdtemp(join(tmpdir(), "inspire-restart-launcher-"));
  directories.push(root);
  await preparePackagedLauncher(root);
  // The launcher fixture must never enumerate or stop real user Pi processes.
  await writeFile(
    join(root, "build/server/pi-processes.mjs"),
    `
    import { appendFileSync } from "node:fs";
    export const supportsGlobalPiStop = () => true;
    export async function assertExternalPiRestartCaller() {
      if (process.env.FIXTURE_PI_ANCESTOR) throw new Error("Run inspire restart --all outside Pi, from an OS terminal.");
    }
    export async function stopAllPiProcesses({ includeHerdr }) {
      appendFileSync(process.env.FIXTURE_LOG, "stop-all-pi:" + includeHerdr + "\\n");
      if (process.env.FIXTURE_STOP_PI_FAIL) throw new Error("Synthetic Pi stop failure");
    }
  `,
  );
  const logPath = await installSystemdManager(root);
  await writeFile(
    join(root, "build/server/restart-preflight.js"),
    `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.FIXTURE_LOG, 'preflight\\n'); process.exit(${fail ? 1 : 0});`,
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
  return {
    root,
    env,
    run: (args: string[]) =>
      execFileSync(process.execPath, command(args), options),
    runAsync: (args: string[]) =>
      promisify(execFile)(process.execPath, command(args), options),
    async runningHost({
      includeHerdr = false,
      confirmExit = true,
      ready = true,
    } = {}) {
      let state: InstanceState;
      const host = await hostApiFixture({
        activeHerdrMode: includeHerdr,
        instanceState: () => (ready ? state : null),
      });
      closeServers.push(() => closeHostApiFixture(host));
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
    log: () => readFile(logPath, "utf8"),
  };
}

describe.runIf(process.platform === "linux")(
  "prepared launcher restarts (isolated service fixture)",
  () => {
    it("installs readiness-gated units and delegates only default Host lifecycles", async () => {
      const f = await fixture(false);
      f.run(["service", "install-host"]);
      const unit = (name: string) =>
        readFile(join(f.env.XDG_CONFIG_HOME!, "systemd/user", name), "utf8");
      const host = await unit("inspire-host.service");
      const terminal = await unit("inspire-terminal.service");
      expect(host).toContain(`ExecStartPost=${f.root}/inspire wait-ready`);
      expect(host).toContain(
        "Wants=network-online.target inspire-terminal.service",
      );
      expect(terminal).toContain(
        `ExecStart=${f.root}/inspire terminal-daemon --root ${f.root}`,
      );
      for (const content of [host, terminal]) {
        expect(content).toContain("Environment=INSPIRE_ENVIRONMENT=shell");
        expect(content).not.toContain("Environment=NODE_ENV=");
        expect(content).not.toContain(f.env.PATH);
      }

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
          expect.stringMatching(/^--user stop inspire-terminal-.*\.service$/u),
          "--user stop inspire-host.service",
          "--user stop inspire-terminal.service",
          "--user enable inspire-terminal.service",
          "--user enable --now inspire-host.service",
          expect.stringMatching(/^--user stop inspire-terminal-.*\.service$/u),
          "--user disable --now inspire-idle-maintenance-restart.timer",
          "--user disable --now inspire-host.service",
          "--user disable --now inspire-terminal.service",
        ],
      );
      f.env.FIXTURE_OUTDATED = "1";
      expect(() => f.run(["status"])).toThrow(/unit is outdated/u);
      f.env.INSPIRE_PORT = "4589";
      expect(() => f.run(["status"])).toThrow(/INSΠRE is not running/u);
    }, 30_000);

    it("leaves both services running when full restart preparation fails", async () => {
      const f = await fixture(true);
      expect(() => f.run(["restart", "--all"])).toThrow(
        /running Host was not stopped/,
      );
      const log = await f.log();
      expect(log).toContain("preflight\n");
      expect(log).not.toMatch(/^--user (start|stop|restart)/mu);
    });
    it("prepares before restarting both services exactly once", async () => {
      const f = await fixture(false);
      f.run(["restart", "--terminals"]);
      const lines = (await f.log()).split("\n");
      const mutations = lines.filter((line) =>
        /^--user (start|stop|restart)/u.test(line),
      );
      expect(mutations).toEqual([
        "--user restart inspire-terminal.service inspire-host.service",
      ]);
      expect(lines).toContain("preflight");
      expect(lines.indexOf("preflight")).toBeLessThan(
        lines.indexOf(mutations[0]!),
      );
    });
    it.each([false, true])(
      "uses running Herdr mode (%s) and stops the owner before Pi cleanup",
      async (includeHerdr) => {
        const f = await fixture(false);
        await f.runningHost({ includeHerdr });
        await f.runAsync(["restart", "--all"]);
        const lines = (await f.log()).split("\n");
        const stopped = lines.indexOf("--user stop inspire-host.service");
        const cleaned = lines.indexOf(`stop-all-pi:${includeHerdr}`);
        const started = lines.indexOf("--user start inspire-host.service");
        expect(stopped).toBeGreaterThan(lines.indexOf("preflight"));
        expect(cleaned).toBeGreaterThan(stopped);
        expect(started).toBeGreaterThan(cleaned);
      },
    );
    it("refuses a Pi-descended caller before preparation or service shutdown", async () => {
      const f = await fixture(false);
      f.env.FIXTURE_PI_ANCESTOR = "1";
      expect(() => f.run(["restart", "--all"])).toThrow(/outside Pi/);
      const log = await f.log();
      expect(log).not.toContain("preflight");
      expect(log).not.toContain("stop-all-pi");
      expect(log).not.toMatch(/^--user (start|stop|restart)/mu);
    });
    it("never starts a replacement after failed global Pi cleanup", async () => {
      const f = await fixture(false);
      f.env.FIXTURE_STOP_PI_FAIL = "1";
      await f.runningHost();
      await expect(f.runAsync(["restart", "--all"])).rejects.toThrow(
        /Synthetic Pi stop failure/,
      );
      expect(await f.log()).toContain("stop-all-pi");
      expect(await f.log()).not.toContain("--user start inspire-host.service");
    });
    it("does not clean Pi or start another Host without process exit proof", async () => {
      const f = await fixture(false);
      await f.runningHost({ confirmExit: false });
      await expect(f.runAsync(["restart", "--all"])).rejects.toThrow(
        /Host exit was not confirmed/u,
      );
      const log = await f.log();
      expect(log).toContain("--user stop inspire-host.service");
      expect(log).not.toContain("stop-all-pi");
      expect(log).not.toContain("--user start inspire-host.service");
    });
    it("verifies the running Host after preflight", async () => {
      const f = await fixture(false);
      await f.runningHost({ ready: false });
      await expect(f.runAsync(["restart"])).rejects.toThrow(
        /Cannot verify the running Host/,
      );
      const log = await f.log();
      expect(log).toContain("preflight\ninspect owner\n");
      expect(log).not.toMatch(/--user (start|stop|restart)/u);
    });
    it("blocks terminal-ending restart inside a project terminal and keeps default Host restart on systemd", async () => {
      const f = await fixture(false);
      f.env.INSPIRE_TERMINAL_ID = "project-terminal";
      expect(() => f.run(["restart", "--all"])).toThrow(/external OS terminal/);
      // The child uses this fixture's runtime directory, not the real user instance.
      f.env.XDG_RUNTIME_DIR = f.root;
      f.env.INSPIRE_HOST = "127.0.0.1";
      f.env.INSPIRE_PORT = "4587";
      f.env.INSPIRE_STATE_PATH = join(
        inspireRuntimeDirectory({ environment: f.env }),
        `${installationKey(f.root, "127.0.0.1", 4587)}.json`,
      );
      const output = f.run(["restart"]);
      expect(output).toContain(
        "Restarted INSΠRE Host. Terminals remain running.",
      );
      const mutations = (await f.log())
        .split("\n")
        .filter((line) => /^--user (start|stop|restart)/u.test(line));
      expect(mutations).toEqual(["--user restart inspire-host.service"]);
    });
    it.each(["--unknown", "--host-only"])(
      "rejects restart flag %s",
      async (flag) => {
        const f = await fixture(false);
        expect(() => f.run(["restart", flag])).toThrow(/Use: inspire restart/);
        expect(await f.log()).not.toMatch(/^--user (start|stop|restart)/mu);
      },
    );
  },
);
