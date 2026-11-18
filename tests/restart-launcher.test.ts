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
    async runningHost({
      includeHerdr = false,
      confirmExit = true,
      ready = true,
    } = {}) {
      let state: InstanceState;
      host = await hostApiFixture({
        activeHerdrMode: includeHerdr,
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
      f.env.FIXTURE_PI_ANCESTOR = "1";
      expect(() => f.run(["restart", "--all"])).toThrow(/outside Pi/);
      delete f.env.FIXTURE_PI_ANCESTOR;
      f.env.INSPIRE_TERMINAL_ID = "project-terminal";
      expect(() => f.run(["restart", "--all"])).toThrow(/external OS terminal/);
      expect(await f.log()).not.toMatch(/preflight|stop-all-pi/);
      expect(await f.mutations()).toEqual([]);

      delete f.env.INSPIRE_TERMINAL_ID;
      f.env.FIXTURE_PREFLIGHT_FAIL = "1";
      expect(() => f.run(["restart", "--all"])).toThrow(
        /running Host was not stopped/,
      );
      expect(await f.mutations()).toEqual([]);
      expect(await f.log()).toContain("preflight\n");
      delete f.env.FIXTURE_PREFLIGHT_FAIL;
      f.run(["restart", "--terminals"]);
      expect(await f.mutations()).toEqual([
        "--user restart inspire-terminal.service inspire-host.service",
      ]);
      expect(await f.log()).toMatch(
        /preflight\n[\s\S]*restart inspire-terminal.service inspire-host.service/,
      );
      // The manager fixture has two invocation IDs. Give the next
      // transaction a fresh service start boundary.
      await rm(join(f.root, "started"));
      f.env.INSPIRE_TERMINAL_ID = "project-terminal";
      expect(f.run(["restart"])).toContain(
        "Restarted INSΠRE Host. Terminals remain running.",
      );
      expect((await f.mutations()).at(-1)).toBe(
        "--user restart inspire-host.service",
      );
    });

    it.each([
      { mode: "direct", includeHerdr: false },
      { mode: "enhanced", includeHerdr: true },
      {
        mode: "readiness lost",
        ready: false,
        error: /Cannot verify the running Host/,
      },
      {
        mode: "exit unconfirmed",
        confirmExit: false,
        error: /Host exit was not confirmed/u,
      },
      {
        mode: "Pi cleanup unconfirmed",
        cleanupFails: true,
        error: /Synthetic Pi stop failure/,
      },
    ])(
      "fences full restart in $mode mode",
      async ({ includeHerdr, ready, confirmExit, cleanupFails, error }) => {
        const f = await fixture();
        if (cleanupFails) f.env.FIXTURE_STOP_PI_FAIL = "1";
        await f.runningHost({ includeHerdr, ready, confirmExit });
        const restart = f.runAsync(["restart", "--all"]);
        if (error) await expect(restart).rejects.toThrow(error);
        else await restart;
        const log = await f.log();
        expect(log).toContain("preflight\ninspect owner\n");
        const effects =
          log.match(
            /^(?:--user (?:stop|start) inspire-host\.service|stop-all-pi:.*)$/gmu,
          ) ?? [];
        expect(effects).toEqual(
          ready === false
            ? []
            : [
                "--user stop inspire-host.service",
                ...(confirmExit === false
                  ? []
                  : [`stop-all-pi:${includeHerdr ?? false}`]),
                ...(!error ? ["--user start inspire-host.service"] : []),
              ],
        );
      },
    );
  },
);
