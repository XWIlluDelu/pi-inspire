import { chmod, copyFile, cp, glob, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

/** Exercise the installed launcher with a controllable Host entrypoint. */
export async function preparePackagedLauncher(root, { host = "" } = {}) {
  const build = join(root, "build", "server");
  const dist = join(root, "dist");
  const source = new URL("../../", import.meta.url);
  await Promise.all([mkdir(build, { recursive: true }), mkdir(dist)]);
  await Promise.all([
    copyFile(new URL("inspire.mjs", source), join(root, "inspire.mjs")),
    writeFile(join(root, "package.json"), '{"type":"module"}'),
    writeFile(join(dist, "index.html"), ""),
    writeFile(join(build, "index.js"), host),
  ]);
  for await (const name of glob("*.mjs", { cwd: new URL("server/", source) })) {
    await copyFile(new URL("server/" + name, source), join(build, name));
  }
}

export async function freeLoopbackPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

export async function directLauncherEnvironment(root) {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    XDG_STATE_HOME: join(root, "state"),
    INSPIRE_HOST: "127.0.0.1",
    INSPIRE_PORT: String(await freeLoopbackPort()),
    INSPIRE_STATE_PATH: join(root, "instance.json"),
    INSPIRE_OPEN: "0",
  };
}

/** Install the real manager adapter with a disposable systemctl subprocess. */
export async function installSystemdManager(root) {
  await cp(
    new URL("../../deploy/systemd", import.meta.url),
    join(root, "deploy/systemd"),
    {
      recursive: true,
    },
  );
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin/package.json"), '{"type":"module"}');
  const systemctl = join(root, "bin/systemctl");
  await writeFile(
    systemctl,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, args.join(' ') + '\\n');
const root = process.env.FIXTURE_ROOT;
const unit = 'inspire-host.service';
if (args.includes(unit)) {
  if (['start', 'restart', 'enable'].includes(args[1])) fs.writeFileSync(root + '/started', '');
  if (['stop', 'disable'].includes(args[1])) {
    fs.rmSync(root + '/started', { force: true });
    fs.writeFileSync(root + '/old-host-exited', '');
  }
}
const oldExited = fs.existsSync(root + '/old-host-exited');
const started = fs.existsSync(root + '/started');
const active = !oldExited || started;
if (args[1] === 'show') console.log([
  'LoadState=loaded', 'FragmentPath=' + process.env.XDG_CONFIG_HOME + '/systemd/user/' + unit,
  'WorkingDirectory=' + root,
  'ExecStart={ path=' + root + '/inspire ; argv[]=' + root + '/inspire ; }',
  'ExecStartPost=' + (process.env.FIXTURE_OUTDATED ? '' : '{ path=' + root + '/inspire ; argv[]=' + root + '/inspire wait-ready ; }'),
  'ActiveState=' + (active ? 'active' : 'inactive'), 'UnitFileState=enabled', 'SubState=running',
  'InvocationID=' + (started ? 'b'.repeat(32) : 'a'.repeat(32))
].join('\\n'));
`,
  );
  await chmod(systemctl, 0o755);
  const logPath = join(root, "calls.log");
  await writeFile(logPath, "");
  return logPath;
}
