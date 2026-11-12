import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

/** Exercise the installed launcher with controllable Host and daemon entrypoints. */
export async function preparePackagedLauncher(
  root,
  { host = "", terminal = "" } = {},
) {
  const build = join(root, "build", "server");
  const dist = join(root, "dist");
  const source = new URL("../../", import.meta.url);
  await Promise.all([mkdir(build, { recursive: true }), mkdir(dist)]);
  await Promise.all([
    copyFile(new URL("inspire.mjs", source), join(root, "inspire.mjs")),
    writeFile(join(root, "package.json"), '{"type":"module"}'),
    writeFile(join(dist, "index.html"), ""),
    writeFile(join(build, "index.js"), host),
    writeFile(join(build, "terminal-daemon-entry.js"), terminal),
    ...[
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
    ].map((name) =>
      copyFile(
        new URL(`server/${name}.mjs`, source),
        join(build, `${name}.mjs`),
      ),
    ),
  ]);
}

export async function directLauncherEnvironment(root) {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
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
    INSPIRE_PORT: String(port),
    INSPIRE_STATE_PATH: join(root, "instance.json"),
    INSPIRE_OPEN: "0",
  };
}
