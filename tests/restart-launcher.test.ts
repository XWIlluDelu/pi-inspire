import { execFile, execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { InstanceHttpControl } from "../server/instance-control.mjs";
import {
  type InstanceState,
  processStartIdentity,
} from "../server/instance-state.mjs";
import {
  inspireRuntimeDirectory,
  installationKey,
} from "../server/platform-paths.mjs";
import { preparePackagedLauncher } from "./fixtures/packaged-launcher.mjs";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(fail: boolean) {
  const root = await mkdtemp(join(tmpdir(), "inspire-restart-launcher-"));
  directories.push(root);
  await preparePackagedLauncher(root);
  await cp(resolve("deploy/systemd"), join(root, "deploy/systemd"), {
    recursive: true,
  });
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin/package.json"), '{"type":"module"}');
  await writeFile(
    join(root, "build/server/restart-preflight.js"),
    `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.FIXTURE_LOG, 'preflight\\n'); process.exit(${fail ? 1 : 0});`,
  );
  const systemctl = join(root, "bin/systemctl");
  await writeFile(
    systemctl,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, args.join(' ') + '\\n');
const root = process.env.FIXTURE_ROOT;
const terminal = args.includes('inspire-terminal.service');
const unit = terminal ? 'inspire-terminal.service' : 'inspire-host.service';
if (args.includes('inspire-host.service')) {
  if (['start', 'restart', 'enable'].includes(args[1])) fs.writeFileSync(root + '/started', '');
  if (['stop', 'disable'].includes(args[1])) {
    fs.rmSync(root + '/started', { force: true });
    fs.writeFileSync(root + '/old-host-exited', '');
  }
}
const oldExited = fs.existsSync(root + '/old-host-exited');
const started = fs.existsSync(root + '/started');
const active = terminal || !oldExited || started;
if (args[1] === 'show') console.log([
  'LoadState=loaded', 'FragmentPath=' + process.env.XDG_CONFIG_HOME + '/systemd/user/' + unit,
  'WorkingDirectory=' + root,
  'ExecStart={ path=' + root + '/inspire ; argv[]=' + root + '/inspire' + (terminal ? ' terminal-daemon --root ' + root + ' --host 127.0.0.1 --port 4587' : '') + ' ; }',
  'ExecStartPost=' + (process.env.FIXTURE_OUTDATED ? '' : '{ path=' + root + '/inspire ; argv[]=' + root + '/inspire wait-ready ; }'),
  'Wants=inspire-terminal.service', 'After=inspire-terminal.service', 'ActiveState=' + (active ? 'active' : 'inactive'), 'UnitFileState=enabled', 'SubState=running',
  'InvocationID=' + (started ? 'b'.repeat(32) : 'a'.repeat(32))
].join('\\n'));
`,
  );
  await chmod(systemctl, 0o755);
  const logPath = join(root, "calls.log");
  await writeFile(logPath, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    FIXTURE_ROOT: root,
    FIXTURE_LOG: logPath,
    INSPIRE_OPEN: "0",
  };
  for (const name of [
    "INSPIRE_STATE_PATH",
    "INSPIRE_HOST",
    "INSPIRE_PORT",
    "INSPIRE_TOKEN",
    "INSPIRE_TERMINAL_ID",
    "SYSTEMD_EXEC_PID",
    "INSPIRE_SYSTEMD",
    "MAINPID",
  ])
    delete env[name];
  const command = (args: string[]) => [join(root, "inspire.mjs"), ...args];
  const options = { env, encoding: "utf8" as const, timeout: 15_000 };
  return {
    root,
    env,
    run: (args: string[]) =>
      execFileSync(process.execPath, command(args), options),
    runAsync: (args: string[]) =>
      promisify(execFile)(process.execPath, command(args), options),
    async stubInstanceState(source: string) {
      const support = join(root, "build", "server");
      const entry = join(support, "instance-state.mjs");
      await rename(entry, join(support, "instance-state.original.mjs"));
      await writeFile(
        entry,
        `export * from "./instance-state.original.mjs";\n${source}`,
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

    it("passes scheduled maintenance through signed Host preparation and commit", async () => {
      const f = await fixture(false);
      const leaseId = "a".repeat(43);
      const actions: string[] = [];
      const control = new InstanceHttpControl();
      let state: InstanceState;
      const server = createServer(async (incoming, response) => {
        let body = "";
        for await (const chunk of incoming) body += String(chunk);
        const message = JSON.parse(body);
        const grant = control.accept(state, message);
        if (!grant) return response.writeHead(401).end();
        actions.push(message.action);
        response.end(
          JSON.stringify(
            control.reply(
              grant,
              message.action === "maintenance-commit"
                ? { kind: "committed", leaseId }
                : { kind: "ready", expiresAt: Date.now() + 30_000, leaseId },
            ),
          ),
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Expected fixture port");
        state = {
          schemaVersion: 1,
          root: f.root,
          host: "127.0.0.1",
          port: address.port,
          token: "synthetic-token",
          pid: process.pid,
          processStartTime: await processStartIdentity(process.pid),
          startedAt: new Date().toISOString(),
          durableWorkerRelease: true,
        };
        f.env.INSPIRE_STATE_PATH = join(f.root, "synthetic-host.json");
        await writeFile(f.env.INSPIRE_STATE_PATH, JSON.stringify(state));
        await f.runAsync(["maintenance-restart"]);
        expect(actions).toEqual(["maintenance-prepare", "maintenance-commit"]);
        expect(await f.log()).toContain("--user restart inspire-host.service");
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }, 20_000);

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
      f.run(["restart", "--all"]);
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
    it.each([{ flags: [] }, { flags: ["--host-only"] }])(
      "verifies the running Host after preflight ($flags)",
      async ({ flags }) => {
        const f = await fixture(false);
        await f.stubInstanceState(`
          import { appendFile } from "node:fs/promises";
          export async function inspectInstance() {
            await appendFile(process.env.FIXTURE_LOG, "inspect owner\\n");
            return { kind: "unavailable" };
          }
        `);
        expect(() => f.run(["restart", ...flags])).toThrow(
          /Cannot verify the running Host/,
        );
        const log = await f.log();
        expect(log).toContain("preflight\ninspect owner\n");
        expect(log).not.toMatch(/--user (start|stop|restart)/u);
      },
    );
    it.each([
      {
        case: "different invocation",
        invocation: "b",
        error: /does not match the requested service/,
      },
      {
        case: "matching invocation",
        invocation: "a",
        error: null,
      },
    ])(
      "binds Host-only restart to the service owner ($case)",
      async ({ invocation, error }) => {
        const f = await fixture(false);
        const owner = {
          pid: 321,
          systemdInvocationId: invocation.repeat(32),
        };
        await f.stubInstanceState(`
          import { appendFile, writeFile } from "node:fs/promises";
          import { join } from "node:path";
          const owner = ${JSON.stringify(owner)};
          export async function inspectInstance() {
            return { kind: "healthy", state: owner };
          }
          export async function stopManagedInstance(_path, { root }, { scopedOwner }) {
            if (scopedOwner !== owner) throw new Error("Missing scoped owner");
            await writeFile(join(root, "old-host-exited"), "");
            await appendFile(process.env.FIXTURE_LOG, "scoped shutdown\\n");
            return { kind: "stopped", state: owner };
          }
        `);
        if (error) {
          expect(() => f.run(["restart", "--host-only"])).toThrow(error);
          expect(await f.log()).not.toMatch(
            /scoped shutdown|--user (start|stop|restart)/u,
          );
        } else {
          f.run(["restart", "--host-only"]);
          const log = await f.log();
          expect(log.match(/^--user (?:start|stop|restart).*$/gmu)).toEqual([
            "--user start inspire-host.service",
          ]);
          expect(log.indexOf("scoped shutdown")).toBeLessThan(
            log.indexOf("--user start"),
          );
        }
      },
    );
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
    it("rejects unknown restart flags", async () => {
      const f = await fixture(false);
      expect(() => f.run(["restart", "--unknown"])).toThrow(
        /Use: inspire restart/,
      );
      expect(await f.log()).not.toMatch(/^--user (start|stop|restart)/mu);
    });
  },
);
