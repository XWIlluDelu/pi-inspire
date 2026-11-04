import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectInspireSource } from "../../server/maintenance-restart.js";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";

const execFile = promisify(execFileCallback);
const directories: string[] = [];
// Source identity checks must never discover or import an installed Pi runtime.
vi.mock("../../server/pi-installation.js", () => ({
  resolvePiInstallationIdentity: vi.fn(),
}));

async function fixture() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-source-")),
  );
  directories.push(parent);
  const root = join(parent, "installation");
  await mkdir(root);
  const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
    "PATH";
  const environment = isolatedTestEnvironment(parent, {
    // Git is fixture input; the isolated Windows runtime only retains OS tools.
    PATH: process.env[pathKey],
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(parent, "no-global-config"),
  });
  for (const [key, value] of Object.entries(environment))
    vi.stubEnv(key, value);
  const git = (...args: string[]) =>
    execFile("git", ["-C", root, ...args], {
      env: environment,
      encoding: "utf8",
    });
  const write = async (path: string, contents: string) => {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  };
  await write(
    "package.json",
    JSON.stringify({ name: "inspire-pi-gui", version: "0.6.5" }),
  );
  const inspect = async (directory = root, missingGit = false) => {
    if (!missingGit) return inspectInspireSource(directory);
    const previous = process.env[pathKey];
    vi.stubEnv(pathKey, join(parent, "empty-bin"));
    try {
      return await inspectInspireSource(directory);
    } finally {
      vi.stubEnv(pathKey, previous);
    }
  };
  const source = async () => {
    await write("server/index.ts", "export {};\n");
    await git("init", "--initial-branch=main");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    );
  };
  return { parent, root, git, write, inspect, source };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("installed Inspire source identity", () => {
  it("retains clean and dirty source revision semantics", async () => {
    const test = await fixture();
    await test.source();
    const revision = (await test.git("rev-parse", "HEAD")).stdout.trim();
    await expect(test.inspect()).resolves.toEqual({ kind: "source", revision });
    await test.write("server/index.ts", "export const changed = true;\n");
    await expect(test.inspect()).resolves.toEqual({
      kind: "source",
      revision: null,
    });
  });

  it("recognizes a worktree gitfile as source authority", async () => {
    const test = await fixture();
    await test.source();
    const worktree = join(test.parent, "worktree");
    await test.git("worktree", "add", "--detach", worktree);
    const revision = (await test.git("rev-parse", "HEAD")).stdout.trim();
    await expect(test.inspect(worktree)).resolves.toEqual({
      kind: "source",
      revision,
    });
  });

  it("does not relabel a source checkout as a package when Git is missing or metadata fails", async () => {
    const test = await fixture();
    await test.source();
    await test.write("build/server/index.js", "export {};\n");
    await expect(test.inspect(test.root, true)).resolves.toEqual({
      kind: "unknown",
    });
    await test.write(".git/index", "corrupt index");
    await expect(test.inspect()).resolves.toEqual({ kind: "unknown" });
  });

  it("requires positive package layout and rejects a broken gitfile", async () => {
    const test = await fixture();
    await expect(test.inspect()).resolves.toEqual({ kind: "unknown" });
    await test.write("build/server/index.js", "export {};\n");
    await expect(test.inspect(test.root, true)).resolves.toEqual({
      kind: "package",
      version: "0.6.5",
    });
    await test.write(".git", "gitdir: missing-metadata\n");
    await expect(test.inspect()).resolves.toEqual({ kind: "unknown" });
  });

  it("recognizes an installed package inside an unrelated Git checkout", async () => {
    const test = await fixture();
    await test.source();
    const packageRoot = join(test.root, "node_modules/inspire-pi-gui");
    await test.write(
      "node_modules/inspire-pi-gui/build/server/index.js",
      "export {};\n",
    );
    await test.write(
      "node_modules/inspire-pi-gui/package.json",
      JSON.stringify({ name: "inspire-pi-gui", version: "0.6.6" }),
    );
    await expect(test.inspect(packageRoot)).resolves.toEqual({
      kind: "package",
      version: "0.6.6",
    });
  });

  it("keeps an exported source tree without Git authority indeterminate", async () => {
    const test = await fixture();
    await test.write("server/index.ts", "export {};\n");
    await test.write("build/server/index.js", "export {};\n");
    await expect(test.inspect()).resolves.toEqual({ kind: "unknown" });
  });
});
