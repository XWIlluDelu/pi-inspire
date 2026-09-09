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
    "npm-command",
    "platform-paths",
    "process-tree",
    "static-asset-cache",
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
if (args[1] === 'show') console.log([
  'LoadState=loaded', 'FragmentPath=' + process.env.XDG_CONFIG_HOME + '/systemd/user/' + unit,
  'WorkingDirectory=' + root,
  'ExecStart={ path=' + root + '/inspire ; argv[]=' + root + '/inspire' + (terminal ? ' terminal-daemon --root ' + root + ' --host 127.0.0.1 --port 4587' : '') + ' ; }',
  'ExecStartPost={ path=' + root + '/inspire ; argv[]=' + root + '/inspire wait-ready ; }',
  'Wants=inspire-terminal.service', 'After=inspire-terminal.service', 'ActiveState=active', 'UnitFileState=enabled', 'SubState=running'
].join('\\n'));
`,
  );
  await chmod(systemctl, 0o755);
  const env = {
    ...process.env,
    PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    FIXTURE_ROOT: root,
    FIXTURE_LOG: join(root, "calls.log"),
    INSPIRE_OPEN: "0",
  };
  for (const name of [
    "INSPIRE_STATE_PATH",
    "INSPIRE_HOST",
    "INSPIRE_PORT",
    "INSPIRE_TOKEN",
    "INSPIRE_MOCK",
    "SYSTEMD_EXEC_PID",
  ])
    delete (env as Record<string, string | undefined>)[name];
  return {
    root,
    env,
    run: (args: string[]) =>
      execFileSync(process.execPath, [join(root, "inspire.mjs"), ...args], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    log: () => readFile(env.FIXTURE_LOG, "utf8"),
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
    it("rejects unknown flags before service inspection", async () => {
      const f = await fixture(false);
      expect(() => f.run(["restart", "--unknown"])).toThrow(
        /Use: inspire restart/,
      );
      await expect(f.log()).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
