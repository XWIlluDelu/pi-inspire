import { execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(fail: boolean) {
  const root = await mkdtemp(join(tmpdir(), "inspire-restart-launcher-"));
  directories.push(root);
  await mkdir(join(root, "build/server"), { recursive: true });
  await mkdir(join(root, "deploy/systemd"), { recursive: true });
  await mkdir(join(root, "dist"));
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin/package.json"), '{"type":"commonjs"}');
  await cp(resolve("inspire.mjs"), join(root, "inspire.mjs"));
  await cp(
    resolve("deploy/systemd/control.mjs"),
    join(root, "deploy/systemd/control.mjs"),
  );
  for (const file of [
    "file-lock",
    "instance-state",
    "instance-control",
    "launcher-restart",
    "npm-command",
    "platform-paths",
    "platform-environment",
    "process-tree",
    "static-asset-cache",
    "user-environment",
  ])
    await cp(
      resolve(`server/${file}.mjs`),
      join(root, `build/server/${file}.mjs`),
    );
  for (const file of [
    "dist/index.html",
    "build/server/index.js",
    "build/server/terminal-daemon-entry.js",
  ])
    await writeFile(join(root, file), "");
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    join(root, "build/server/restart-preflight.js"),
    `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.FIXTURE_LOG, 'preflight\\n'); process.exit(${fail ? 1 : 0});`,
  );
  const systemctl = join(root, "bin/systemctl");
  await writeFile(
    systemctl,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, args.join(' ') + '\\n');
const root = process.env.FIXTURE_ROOT;
const terminal = args.includes('inspire-terminal.service');
const unit = terminal ? 'inspire-terminal.service' : 'inspire-host.service';
if (args[1] === 'start') fs.writeFileSync(root + '/started', '');
const oldExited = fs.existsSync(root + '/old-host-exited');
const started = fs.existsSync(root + '/started');
const active = terminal || !oldExited || started;
if (args[1] === 'show') console.log([
  'LoadState=loaded', 'FragmentPath=' + process.env.XDG_CONFIG_HOME + '/systemd/user/' + unit,
  'WorkingDirectory=' + root,
  'ExecStart={ path=' + root + '/inspire ; argv[]=' + root + '/inspire' + (terminal ? ' terminal-daemon --root ' + root + ' --host 127.0.0.1 --port 4587' : '') + ' ; }',
  'ExecStartPost={ path=' + root + '/inspire ; argv[]=' + root + '/inspire wait-ready ; }',
  'Wants=inspire-terminal.service', 'After=inspire-terminal.service', 'ActiveState=' + (active ? 'active' : 'inactive'), 'UnitFileState=enabled', 'SubState=running',
  'InvocationID=' + (started ? 'b'.repeat(32) : 'a'.repeat(32))
].join('\\n'));
`,
  );
  await chmod(systemctl, 0o755);
  const logPath = join(root, "calls.log");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
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
  ])
    delete env[name];
  return {
    root,
    env,
    run: (args: string[]) =>
      execFileSync(process.execPath, [join(root, "inspire.mjs"), ...args], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    log: () => readFile(logPath, "utf8"),
  };
}

describe.runIf(process.platform === "linux")(
  "prepared launcher restarts (isolated service fixture)",
  () => {
    it.each([{ args: [] }, { args: ["--all"] }])(
      "never stops a service when preparation fails: $args",
      async ({ args }) => {
        const f = await fixture(true);
        expect(() => f.run(["restart", ...args])).toThrow(
          /running Host was not stopped/,
        );
        const log = await f.log();
        expect(log).toContain("preflight\n");
        expect(
          log.split("\n").filter((line) => /--user (stop|restart)/u.test(line)),
        ).toEqual([]);
      },
    );
    it.each([{ args: [] }, { args: ["--all"] }])(
      "prepares before the one correctly scoped restart: $args",
      async ({ args }) => {
        const f = await fixture(false);
        const output = f.run(["restart", ...args]);
        expect(output).toContain(
          args.length
            ? "Host and terminal services"
            : "Terminals remain running",
        );
        const lines = (await f.log()).split("\n");
        const mutations = lines.filter((line) =>
          /--user (stop|restart)/u.test(line),
        );
        expect(mutations).toEqual([
          `--user restart ${args.length ? "inspire-terminal.service " : ""}inspire-host.service`,
        ]);
        expect(lines.indexOf("preflight")).toBeLessThan(
          lines.indexOf(mutations[0]!),
        );
      },
    );
    it("requires an external terminal only when restart would end project terminals", async () => {
      const f = await fixture(false);
      f.env.INSPIRE_TERMINAL_ID = "project-terminal";
      expect(() => f.run(["restart", "--all"])).toThrow(/external OS terminal/);
      await expect(f.log()).rejects.toMatchObject({ code: "ENOENT" });

      expect(f.run(["restart"])).toContain("Terminals remain running");
      expect(await f.log()).toContain("--user restart inspire-host.service");
    });
    it("does not stop a service when Pi restart preparation fails", async () => {
      const f = await fixture(false);
      const path = join(f.root, "build/server", "instance-state.mjs");
      const original = await readFile(path, "utf8");
      await writeFile(
        path,
        original.replace(
          "export async function prepareInstanceRestart(path, expected) {",
          'export async function prepareInstanceRestart(path, expected) { throw new Error("Pi restart preparation failed");',
        ),
      );
      expect(() => f.run(["restart"])).toThrow(/Pi restart preparation failed/);
      expect(
        (await f.log())
          .split("\n")
          .filter((line) => /--user (stop|restart)/u.test(line)),
      ).toEqual([]);
    });
    it("rejects Host-only restart of an active service without an authenticated owner", async () => {
      const f = await fixture(false);
      expect(() => f.run(["restart", "--host-only"])).toThrow(
        /Cannot verify the running Host/,
      );
      expect(await f.log()).not.toMatch(/--user (start|stop|restart)/u);
    });
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
        const path = join(f.root, "build/server", "instance-state.mjs");
        const original = await readFile(path, "utf8");
        const owner = {
          pid: 321,
          systemdInvocationId: invocation.repeat(32),
        };
        await writeFile(
          path,
          original
            .replace(
              "export async function inspectInstance(path, expected, options = {}) {",
              `export async function inspectInstance(path, expected, options = {}) {
            return { kind: "healthy", state: ${JSON.stringify(owner)} };`,
            )
            .replace(
              "export async function stopManagedInstance(path, expected, options = {}) {",
              `export async function stopManagedInstance(path, expected, options = {}) {
            if (JSON.stringify(options.scopedOwner) !== ${JSON.stringify(JSON.stringify(owner))}) throw new Error("Missing scoped owner");
            await writeFile(join(expected.root, "old-host-exited"), "");
            await (await import("node:fs/promises")).appendFile(process.env.FIXTURE_LOG, "scoped shutdown\\n");
            return { kind: "stopped", state: options.scopedOwner };`,
            ),
        );
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
    it("keeps inherited default instance values under the installed service", async () => {
      const f = await fixture(false);
      const { inspireRuntimeDirectory } = await import(
        "../server/platform-paths.mjs"
      );
      const { createHash } = await import("node:crypto");
      const stateName = createHash("sha256")
        .update(f.root)
        .update("\0")
        .update("127.0.0.1")
        .update("\0")
        .update("4587")
        .digest("hex");
      // The child uses this fixture's runtime directory, not the real user instance.
      f.env.XDG_RUNTIME_DIR = f.root;
      f.env.INSPIRE_HOST = "127.0.0.1";
      f.env.INSPIRE_PORT = "4587";
      f.env.INSPIRE_STATE_PATH = join(
        inspireRuntimeDirectory({ environment: f.env }),
        stateName + ".json",
      );
      const output = f.run(["restart"]);
      expect(output).toContain(
        "Restarted INSΠRE Host. Terminals remain running.",
      );
      const mutations = (await f.log())
        .split("\n")
        .filter((line) => /--user (stop|restart)/u.test(line));
      expect(mutations).toEqual(["--user restart inspire-host.service"]);
    });
    it("enables the Host without opting into scheduled restarts", async () => {
      const f = await fixture(false);
      f.run(["service", "enable-host"]);
      expect(await f.log()).toContain(
        "--user enable --now inspire-host.service",
      );
      expect(await f.log()).not.toContain(
        "inspire-idle-maintenance-restart.timer",
      );
    });
    it("rejects unknown flags before service inspection", async () => {
      const f = await fixture(false);
      expect(() => f.run(["restart", "--unknown"])).toThrow(
        /Use: inspire restart/,
      );
      await expect(f.log()).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
