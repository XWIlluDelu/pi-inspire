import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inspire-environment-launcher-"));
  directories.push(root);
  await mkdir(join(root, "build/server"), { recursive: true });
  await mkdir(join(root, "dist"));
  await cp(resolve("inspire.mjs"), join(root, "inspire.mjs"));
  for (const file of [
    "file-lock",
    "instance-state",
    "npm-command",
    "platform-paths",
    "process-tree",
    "static-asset-cache",
    "user-environment",
  ]) {
    await cp(
      resolve(`server/${file}.mjs`),
      join(root, `build/server/${file}.mjs`),
    );
  }
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "dist/index.html"), "test");
  const entry = `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.ENV_PROBE_OUTPUT, JSON.stringify({
  nodeEnv: process.env.NODE_ENV ?? null,
  probe: process.env.ENV_PROBE ?? null,
  path: process.env.PATH,
  mode: process.env.INSPIRE_ENVIRONMENT,
}));`;
  await writeFile(join(root, "build/server/index.js"), entry);
  await writeFile(join(root, "build/server/terminal-daemon-entry.js"), entry);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a TCP address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_RUNTIME_DIR: join(root, "runtime"),
    XDG_CONFIG_HOME: join(root, "config"),
    INSPIRE_STATE_PATH: join(root, "state.json"),
    INSPIRE_HOST: "127.0.0.1",
    INSPIRE_PORT: String(address.port),
    INSPIRE_OPEN: "0",
    INSPIRE_ENVIRONMENT: "inherit",
    ENV_PROBE_OUTPUT: join(root, "environment.json"),
  };
  delete env.NODE_ENV;
  delete env.SYSTEMD_EXEC_PID;
  return {
    root,
    env,
    launch: async (mode: string) => {
      await run(process.execPath, [join(root, "inspire.mjs"), mode], {
        env,
        timeout: 15_000,
      });
      return JSON.parse(await readFile(env.ENV_PROBE_OUTPUT!, "utf8")) as {
        nodeEnv: string | null;
        probe: string | null;
        path: string;
        mode?: string;
      };
    },
  };
}

describe("packaged launcher environment boundary", () => {
  it.each(["mock", "terminal-daemon"])(
    "does not inject NODE_ENV into %s",
    async (mode) => {
      const f = await fixture();
      f.env.ENV_PROBE = "caller-export";
      expect(await f.launch(mode)).toMatchObject({
        nodeEnv: null,
        probe: "caller-export",
        path: f.env.PATH,
      });
      f.env.NODE_ENV = "test";
      expect((await f.launch(mode)).nodeEnv).toBe("test");
      f.env.NODE_ENV = "";
      expect((await f.launch(mode)).nodeEnv).toBe("");
    },
  );

  it.runIf(process.platform !== "win32")(
    "resolves service-mode environment before either runtime starts",
    async () => {
      const f = await fixture();
      f.env.INSPIRE_ENVIRONMENT = "shell";
      f.env.INSPIRE_SHELL = "/bin/bash";
      await writeFile(join(f.root, ".bash_profile"), '. "$HOME/.bashrc"\n');
      await writeFile(
        join(f.root, ".bashrc"),
        'export ENV_PROBE=shell-export\nexport PATH="$HOME/.local/bin:$PATH"\n',
      );
      for (const mode of ["mock", "terminal-daemon"]) {
        const result = await f.launch(mode);
        expect(result).toMatchObject({
          nodeEnv: null,
          probe: "shell-export",
          mode: "inherit",
        });
        expect(result.path.startsWith(`${f.root}/.local/bin:`)).toBe(true);
      }
    },
  );
});
