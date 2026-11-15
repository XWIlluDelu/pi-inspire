import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitInspectionService } from "../../server/git-inspection.js";
import {
  createGitInspectionRunner,
  GIT_CONFIG_ARGS,
} from "../../server/git-runner.js";

const exec = promisify(execFile);
let directory: string | undefined;
const service = new GitInspectionService();
const pathId = (path: string) => Buffer.from(path).toString("base64url");
const textId = pathId("text.txt");
const gitAt =
  (cwd: string) =>
  (...args: string[]) =>
    exec("git", [
      "-C",
      cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      ...args,
    ]);
const quote = (value: string) =>
  "'" + value.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";

async function commandProbe(directory: string, name: string, code = "") {
  const marker = join(directory, `${name}-ran`);
  const program = join(directory, `${name}.cjs`);
  await writeFile(
    program,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n${code}`,
  );
  return { marker, command: `${quote(process.execPath)} ${quote(program)}` };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function repositoryStatus(cwd: string) {
  const status = await service.status(cwd);
  if (status.kind !== "repository") throw new Error("Expected repository");
  return status;
}

async function repository() {
  directory = await mkdtemp(join(tmpdir(), "inspire-git-test-"));
  const project = await realpath(directory);
  const root = join(project, "repo"),
    home = join(project, "home");
  const xdg = join(home, ".config", "git"),
    system = join(project, "system.gitconfig");
  await mkdir(root);
  await mkdir(xdg, { recursive: true });
  await writeFile(system, "");
  for (const key of Object.keys(process.env))
    if (/^GIT_/iu.test(key)) vi.stubEnv(key, undefined);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("GIT_CONFIG_SYSTEM", system);
  const git = gitAt(root);
  await git("init", "-q");
  const file = join(root, "text.txt");
  const stage = async (content = "first\r\nsecond\r\n") => {
    await writeFile(file, content);
    await git("add", "text.txt");
    // Force content comparison instead of relying on the index's stat shortcut.
    await utimes(file, new Date(), new Date(Date.now() + 2_000));
  };
  return {
    directory: project,
    root,
    home,
    xdg,
    system,
    git,
    file,
    stage,
    global: join(home, ".gitconfig"),
  };
}

async function repositoryWithSubmodule() {
  const f = await repository();
  await writeFile(f.global, "[core]\n autocrlf = true\n");
  await f.stage("parent\n");
  await f.git("commit", "-qm", "parent");
  await f.git("config", "core.autocrlf", "false");
  const origin = join(f.directory, "module-origin");
  await mkdir(origin);
  const originGit = gitAt(origin);
  await originGit("init", "-q");
  await writeFile(join(origin, "text.txt"), "first\r\nsecond\r\n");
  await originGit("add", ".");
  await originGit("commit", "-qm", "module");
  await f.git(
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    origin,
    "module",
  );
  await f.git("commit", "-qm", "module pointer");
  const module = join(f.root, "module");
  const moduleGit = gitAt(module);
  await moduleGit("config", "core.autocrlf", "true");
  return { ...f, module, moduleGit };
}

describe("effective safe Git configuration in real repositories", () => {
  it("honors system, home and XDG EOL data when comparing an unborn repository", async () => {
    const f = await repository();
    const gone = join(f.root, "gone");
    await writeFile(f.system, "[core]\n autocrlf = true\n");
    await writeFile(gone, "gone\n");
    await f.git("add", "gone");
    await rm(gone);
    await writeFile(join(f.root, "untracked"), "new\n");
    await writeFile(join(f.root, "empty"), "");
    await f.stage();
    const configOnly = join(f.directory, "config-only");
    await writeFile(configOnly, "[core]\n autocrlf = false\n");
    vi.stubEnv("GIT_CONFIG", configOnly);
    const indexPath = join(f.root, ".git", "index");
    const index = await readFile(indexPath);
    for (const [configuration, value] of [
      [f.system, " = true"],
      [f.global, ""],
      [join(f.xdg, "config"), " = true"],
    ] as const) {
      await writeFile(configuration, "[core]\n autocrlf" + value + "\n");
      // Confirm native comparison with and without a working edit against the same index.
      await writeFile(f.file, "first\r\nsecond\r\n");
      await utimes(f.file, new Date(), new Date(Date.now() + 2_000));
      const { head, files, total } = await repositoryStatus(f.root);
      expect(head.kind).toBe("unborn");
      expect(total).toBe(3);
      expect(files.map(({ path }) => path.utf8Path).sort()).toEqual([
        "empty",
        "text.txt",
        "untracked",
      ]);
      const text = files.find(({ path }) => path.id === textId)!;
      expect(text.staged).toEqual({ kind: "added" });
      expect(text.unstaged).toBeUndefined();
      for (const file of files)
        expect(file.worktree).toEqual({ kind: "added" });
      await writeFile(f.file, "first worktree\r\nsecond\r\n");
      expect(await service.diff(f.root, textId)).toMatchObject({
        kind: "text",
        additions: 2,
        deletions: 0,
        lines: expect.arrayContaining([
          expect.objectContaining({ text: "+first worktree" }),
        ]),
      });
      await writeFile(configuration, "");
    }
    for (const [name, additions] of [
      ["empty", 0],
      ["untracked", 1],
    ] as const) {
      expect(await service.diff(f.root, pathId(name))).toMatchObject({
        kind: "text",
        additions,
        deletions: 0,
      });
    }
    expect(await readFile(indexPath)).toEqual(index);
  }, 20_000);

  it("preserves conditional includes, repository/worktree overrides and attributes on every refresh", async () => {
    const f = await repository();
    await writeFile(f.system, "[core]\n autocrlf = true\n");
    await writeFile(join(f.xdg, "config"), "[core]\n autocrlf = false\n");
    await writeFile(
      join(f.home, "included.gitconfig"),
      "[core]\n autocrlf = true\n",
    );
    const gitDirectory = f.root.replaceAll("\\", "/") + "/.git";
    await writeFile(
      f.global,
      `[core]\n autocrlf = false\n[includeIf "gitdir:${gitDirectory}"]\n path = included.gitconfig\n`,
    );
    await f.stage();
    let comparisons = 0;
    const unstaged = async () => {
      // A config edit does not invalidate Git's cached clean stat by itself.
      await utimes(
        f.file,
        new Date(),
        new Date(Date.now() + ++comparisons * 2_000),
      );
      const normal = (await f.git("status", "--porcelain=v2")).stdout;
      const { files } = await repositoryStatus(f.root);
      const file = files.find(({ path }) => path.id === textId)!;
      expect(file.staged).toEqual({ kind: "added" });
      expect(!!file.unstaged).toBe(/1 AM /u.test(normal));
      return file.unstaged;
    };
    expect(await unstaged()).toBeUndefined();
    await f.git("config", "core.autocrlf", "false");
    expect(await unstaged()).toEqual({ kind: "modified" });
    await f.git("config", "extensions.worktreeConfig", "true");
    await f.git("config", "--worktree", "core.autocrlf", "true");
    expect(await unstaged()).toBeUndefined();
    await writeFile(join(f.root, ".gitattributes"), "text.txt -text\n");
    expect(await unstaged()).toEqual({ kind: "modified" });
    await writeFile(join(f.root, ".gitattributes"), "text.txt text eol=crlf\n");
    expect(await unstaged()).toBeUndefined();
  }, 20_000);

  it("keeps default, home-relative and absolute Unicode attributes and excludes as data", async () => {
    const f = await repository();
    const config = "[core]\n autocrlf = false\n";
    const defaultAttributes = join(f.xdg, "attributes");
    const defaultIgnore = join(f.xdg, "ignore");
    const attributes = "attributes own-研究";
    const ignore = "ignore own-研究";
    await writeFile(f.global, config);
    await writeFile(defaultAttributes, "text.txt text eol=crlf\n");
    await writeFile(defaultIgnore, "globally-ignored.txt\n");
    await f.stage();
    await writeFile(join(f.root, "globally-ignored.txt"), "hidden\n");
    await writeFile(join(f.root, "visible.txt"), "visible\n");
    const expectFiles = async () => {
      const { files } = await repositoryStatus(f.root);
      expect(files.map(({ path }) => path.utf8Path)).toEqual([
        "text.txt",
        "visible.txt",
      ]);
      expect(files[0]!.unstaged).toBeUndefined();
    };
    await expectFiles();
    await rename(defaultAttributes, join(f.home, attributes));
    await rename(defaultIgnore, join(f.home, ignore));
    for (const prefix of ["~/", f.home.replaceAll("\\", "/") + "/"]) {
      await writeFile(
        f.global,
        `${config} attributesFile = "${prefix}${attributes}"\n excludesFile = "${prefix}${ignore}"\n`,
      );
      await expectFiles();
    }
  }, 15_000);

  it("preserves protected trust and shares a safe configuration file across native queries", async () => {
    const f = await repository();
    const root = f.root.replaceAll("\\", "/");
    await writeFile(f.system, "[safe]\n directory = *\n");
    await writeFile(
      f.global,
      `[safe]\n directory =\n directory = ${JSON.stringify(root)}\n[core]\n autocrlf = true\n`,
    );
    await f.git("config", "safe.directory", "/repository-must-not-be-promoted");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "safe.directory");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "/explicit-command");
    const runner = createGitInspectionRunner(f.root);
    const query = (...args: string[]) =>
      runner([...GIT_CONFIG_ARGS, "-C", f.root, ...args], {
        stdoutLimit: 4_096,
      });
    let path: string;
    try {
      const [trust, config] = await Promise.all([
        query(
          "config",
          "--null",
          "--show-scope",
          "--get-all",
          "safe.directory",
        ),
        query("config", "--null", "--show-origin", "--get", "core.autocrlf"),
      ]);
      expect(trust.stdout.toString("utf8").split("\0")).toEqual([
        "global",
        "*",
        "global",
        "",
        "global",
        root,
        "local",
        "/repository-must-not-be-promoted",
        "command",
        "/explicit-command",
        "",
      ]);
      const [origin, value] = config.stdout.toString("utf8").split("\0");
      expect(value).toBe("true");
      path = origin!.slice("file:".length);
      await access(path);
      await expect(
        query("rev-parse", "--verify", "refs/heads/not-created"),
      ).rejects.toMatchObject({ status: 502 });
      await access(path);
    } finally {
      await runner.close();
    }
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("projects EOL overrides but never hooks, external diff, textconv or injected Git authority", async () => {
    const f = await repository();
    await writeFile(f.global, "[core]\n autocrlf = true\n");
    await f.stage();
    await f.git("commit", "-qm", "base");
    const { marker, command } = await commandProbe(
      f.directory,
      "external-diff",
      'process.stdout.write("converted\\n");',
    );
    const hooks = join(f.directory, "hooks");
    await mkdir(hooks);
    await writeFile(
      join(hooks, "post-index-change"),
      "#!/bin/sh\nexec " + command + "\n",
      { mode: 0o755 },
    );
    const config = JSON.stringify(command);
    await writeFile(
      f.global,
      `[core]\n autocrlf = false\n fsmonitor = ${config}\n hooksPath = ${JSON.stringify(hooks.replaceAll("\\", "/"))}\n[diff]\n external = ${config}\n[diff "owned"]\n command = ${config}\n textconv = ${config}\n`,
    );
    await f.git("config", "diff.owned.textconv", command);
    await f.git("config", "core.fsmonitor", command);
    await writeFile(join(f.root, ".gitattributes"), "text.txt diff=owned\n");
    await writeFile(f.file, "other\r\nsecond\r\n");
    vi.stubEnv("GIT_DIR", join(f.directory, "not-the-repository"));
    vi.stubEnv("GIT_WORK_TREE", f.directory);
    vi.stubEnv("GIT_EXTERNAL_DIFF", command);
    vi.stubEnv("GIT_CONFIG_COUNT", "2");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.autocrlf");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "true");
    vi.stubEnv("GIT_CONFIG_KEY_1", "core.fsmonitor");
    vi.stubEnv("GIT_CONFIG_VALUE_1", command);
    const result = await service.diff(f.root, textId);
    expect(result).toMatchObject({ kind: "text", additions: 1, deletions: 1 });
    if (result.kind === "text") {
      expect(result.lines.some((line) => line.text === "+other")).toBe(true);
      expect(result.lines.some((line) => line.text.includes("converted"))).toBe(
        false,
      );
    }
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it.each([
    ["global", "clean"],
    ["repository", "process"],
  ] as const)(
    "blocks an actually used %s %s filter without rejecting unrelated files",
    async (scope, method) => {
      const f = await repository();
      await f.stage("before\n");
      await f.git("commit", "-qm", "base");
      const { marker, command } = await commandProbe(
        f.directory,
        "filter",
        method === "clean"
          ? "process.stdin.pipe(process.stdout);"
          : "process.exit(1);",
      );
      if (scope === "global")
        await writeFile(
          f.global,
          '[filter "Owned.Driver"]\n ' +
            method +
            " = " +
            JSON.stringify(command) +
            "\n",
        );
      else await f.git("config", "filter.Owned.Driver." + method, command);
      await writeFile(
        join(f.root, ".gitattributes"),
        "text.txt filter=Owned.Driver\n",
      );
      await writeFile(f.file, "after!\n");
      // The process probe intentionally exits: only invocation is under test.
      await f
        .git("diff", "--no-ext-diff", "--no-textconv")
        .catch(() => undefined);
      await access(marker); // Prove ordinary Git would execute the owned driver.
      await rm(marker);
      await expect(service.status(f.root)).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("External content filters"),
        detail: expect.stringContaining("clean filter 'Owned.Driver' failed"),
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(f.file, "different-sized content\n");
      await expect(service.diff(f.root, textId)).rejects.toMatchObject({
        status: 422,
        detail: expect.stringContaining("clean filter 'Owned.Driver' failed"),
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(
        join(f.root, ".gitattributes"),
        "*.asset filter=Owned.Driver\n",
      );
      expect(await service.diff(f.root, textId)).toMatchObject({
        kind: "text",
        additions: 1,
        deletions: 1,
      });
      if (scope === "global") {
        // A repository override can disable the global conversion even when
        // the file still selects its driver.
        await f.git("config", "filter.Owned.Driver.clean", "");
        await writeFile(
          join(f.root, ".gitattributes"),
          "text.txt filter=Owned.Driver\n",
        );
        expect(await service.diff(f.root, textId)).toMatchObject({
          kind: "text",
          additions: 1,
          deletions: 1,
        });
      }
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
    20_000,
  );

  it("preserves submodule state through EOL and configuration changes", async () => {
    const f = await repositoryWithSubmodule();
    const file = join(f.module, "text.txt");
    await utimes(file, new Date(), new Date(Date.now() + 2_000));
    expect((await f.git("status", "--porcelain=v2")).stdout).toBe("");
    await utimes(file, new Date(), new Date(Date.now() + 4_000));
    const state = async () => (await repositoryStatus(f.root)).files;
    expect(await state()).toEqual([]);
    await writeFile(join(f.module, "untracked.txt"), "untracked\n");
    const expectSubmodule = async (
      trackedModified: boolean,
      commitChanged = false,
    ) => {
      const files = await state();
      expect(files).toMatchObject([
        {
          path: { utf8Path: "module" },
          submodule: { commitChanged, trackedModified, untracked: true },
        },
      ]);
      return files[0]!;
    };
    await expectSubmodule(false);
    await writeFile(file, "other\r\nsecond\r\n");
    await expectSubmodule(true);

    const { marker, command } = await commandProbe(
      f.directory,
      "recursive-filter",
      "process.stdin.pipe(process.stdout);",
    );
    await f.moduleGit("config", "filter.Recursive.clean", command);
    await writeFile(
      join(f.module, ".gitattributes"),
      "text.txt filter=Recursive\n",
    );
    await utimes(file, new Date(), new Date(Date.now() + 2_000));
    await f.git("status", "--porcelain=v2");
    await access(marker);
    await rm(marker);
    // The ordinary probe may cache a clean stat; force content comparison again.
    await utimes(file, new Date(), new Date(Date.now() + 4_000));
    await expect(service.status(f.root)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("External content filters"),
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(
      join(f.module, ".gitattributes"),
      "*.asset filter=Recursive\n",
    );
    await expectSubmodule(true);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });

    await f.moduleGit("add", "text.txt");
    await f.moduleGit("commit", "-qm", "new module head");
    const monitor = await commandProbe(f.directory, "fsmonitor");
    await f.moduleGit("config", "core.fsmonitor", monitor.command);
    const module = await expectSubmodule(false, true);
    await expect(service.diff(f.root, module.path.id)).resolves.toMatchObject({
      kind: "submodule",
    });
    await expect(access(monitor.marker)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await f.moduleGit("status", "--porcelain");
    await access(monitor.marker);
    await f.moduleGit("config", "--unset", "core.fsmonitor");

    await writeFile(join(f.home, "root-only"), "[core]\n safecrlf = true\n");
    await writeFile(
      f.global,
      "[core]\n autocrlf = true\n" +
        '[includeIf "gitdir:' +
        f.root.replaceAll("\\", "/") +
        '/.git"]\n path = root-only\n',
    );
    await expect(service.status(f.root)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("conditional submodule settings"),
    });
  }, 30_000);

  it("never lazily fetches missing objects through a configured upload-pack program", async () => {
    const f = await repository();
    await f.stage("before\n");
    await f.git("commit", "-qm", "base");
    const object = (await f.git("rev-parse", ":text.txt")).stdout.trim();
    await rm(
      join(f.root, ".git", "objects", object.slice(0, 2), object.slice(2)),
    );
    await writeFile(f.file, "after\n");
    const { marker, command } = await commandProbe(
      f.directory,
      "uploadpack",
      "process.exit(1);",
    );
    await f.git("config", "remote.owned.url", f.root);
    await f.git("config", "remote.owned.promisor", "true");
    await f.git("config", "remote.owned.uploadpack", command);
    // Control: ordinary Git really invokes the owned helper for this missing blob.
    await f
      .git("diff", "HEAD", "--no-ext-diff", "--no-textconv")
      .catch(() => undefined);
    await access(marker);
    await rm(marker);
    await expect(service.diff(f.root, textId)).rejects.toMatchObject({
      status: 502,
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("fails bounded config reads and propagates cancellation rather than dropping settings", async () => {
    const f = await repository();
    await writeFile(f.global, "[core]\n" + " autocrlf = true\n".repeat(4_000));
    await expect(service.status(f.root)).rejects.toThrow(/output exceeded/u);
    await writeFile(f.global, "[core\n");
    await expect(service.status(f.root)).rejects.toMatchObject({ status: 502 });
    await expect(
      service.status(f.root, AbortSignal.abort()),
    ).rejects.toMatchObject({ status: 499 });
  });
});

describe("native working tree projection", () => {
  it("accepts Git's paired unknown ahead/behind tracking header through the real service", async () => {
    const { directory, root, git } = await repository();
    const origin = join(directory, "origin");
    await git("init", "-q", "--bare", origin);
    await writeFile(join(root, "tracked.txt"), "base\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await git("remote", "add", "origin", origin);
    await git("push", "-qu", "origin", "HEAD");
    await writeFile(join(root, "tracked.txt"), "local-commit\n");
    await git("commit", "-qam", "ahead");
    await writeFile(join(root, "tracked.txt"), "working-change\n");

    expect(await repositoryStatus(root)).toMatchObject({
      head: { kind: "branch" },
      files: [
        { path: { utf8Path: "tracked.txt" }, unstaged: { kind: "modified" } },
      ],
    });
  });

  it.runIf(process.platform !== "win32")(
    "maps a nested detached workspace and treats pathspec-like names literally",
    async () => {
      const { root, git } = await repository();
      const nested = join(root, "line\nbreak");
      const magic = ":(glob)*.txt";
      await mkdir(nested);
      await writeFile(join(nested, "inside.txt"), "nested base\n");
      await writeFile(join(root, magic), "literal base\n");
      await git("add", ".");
      await git("commit", "-qm", "initial");
      await git("checkout", "-q", "--detach");
      await writeFile(join(nested, "inside.txt"), "nested update\n");
      await writeFile(join(root, magic), "literal update\n");

      const status = await repositoryStatus(nested);
      expect(status).toMatchObject({
        kind: "repository",
        head: { kind: "detached" },
      });
      expect(
        status.files.find(
          (file) => file.path.utf8Path === "line\nbreak/inside.txt",
        )?.path.workspacePath,
      ).toBe("inside.txt");
      const outside = status.files.find(
        (file) => file.path.utf8Path === magic,
      )!;
      expect(outside.path.workspacePath).toBeUndefined();
      expect(await service.diff(nested, outside.path.id)).toMatchObject({
        kind: "text",
        additions: 1,
        deletions: 1,
        lines: expect.arrayContaining([
          expect.objectContaining({ kind: "add", text: "+literal update" }),
        ]),
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "never opens untracked content through symlinks, directory swaps, FIFOs, or device targets",
    async () => {
      const { directory, root } = await repository();
      const outside = join(directory, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "secret"), "must-not-be-read\n");
      await symlink(join(outside, "secret"), join(root, "final-link"));
      await symlink(outside, join(root, "intermediate-link"));
      await symlink("/dev/null", join(root, "device-link"));
      await exec("mkfifo", [join(root, "named-pipe")]);
      await mkdir(join(root, "swap"));
      await writeFile(join(root, "swap", "victim"), "before-swap\n");

      const initial = await repositoryStatus(root);
      const byPath = (path: string) =>
        initial.files.find((file) => file.path.utf8Path === path)!;
      const bounded = <T>(operation: Promise<T>) =>
        Promise.race([
          operation,
          delay(750).then(() => {
            throw new Error("untracked inspection hung");
          }),
        ]);
      for (const path of ["final-link", "intermediate-link", "device-link"]) {
        const change = byPath(path);
        expect(change, path).toBeDefined();
        await expect(
          bounded(service.diff(root, change.path.id)),
        ).resolves.toMatchObject({
          kind: "unsupported",
          reason: "untracked-content",
        });
      }

      await expect(
        bounded(service.diff(root, pathId("named-pipe"))),
      ).rejects.toMatchObject({ status: 409 });

      const victim = byPath("swap/victim");
      expect(victim).toBeDefined();
      await rename(join(root, "swap"), join(root, "swap-original"));
      await symlink(outside, join(root, "swap"));
      await expect(
        bounded(service.diff(root, victim.path.id)),
      ).rejects.toMatchObject({ status: 409 });
    },
  );

  it("shows one HEAD-to-worktree change per file with machine patch grammar", async () => {
    const { root, git } = await repository();
    const file = (path: string, contents: string | Buffer) =>
      writeFile(join(root, path), contents);
    const base = "base\n\nthird\n";
    const edit = (line: string) => `${line}\n\nthird\n`;
    for (const path of [
      "staged",
      "unstaged",
      "both",
      "canceled",
      "restored-source",
      "recreated",
    ])
      await file(path, base);
    const renameContents = (line: string) =>
      `${line}\nsecond rename\nthird rename\n`;
    await file("rename-old", renameContents("rename unique"));
    await file("deleted", "deleted unique\nsecond deleted\nthird deleted\n");
    await writeFile(join(root, "tracked-binary"), Buffer.from([0, 1]));
    await git("add", ".");
    await git("commit", "-qm", "base");
    await git("config", "color.diff", "always");
    await git("config", "diff.suppressBlankEmpty", "true");
    for (const path of ["tracked-binary", "new-binary"])
      await file(path, Buffer.from([0, 1, 2]));
    for (const path of ["staged", "both", "canceled"])
      await file(path, edit("staged"));
    await git("add", "staged", "both", "canceled");
    await file("unstaged", edit("working"));
    await file("both", edit("final"));
    await file("canceled", base);
    await rm(join(root, "deleted"));
    await git("mv", "rename-old", "rename-new");
    await git("mv", "restored-source", "restored-target");
    await file("restored-source", base);
    await file("new-file", "new line\nlast line");
    // A removed index entry with the original file still on disk is another
    // legitimate cancellation; porcelain emits both D and ? for this identity.
    await git("rm", "--cached", "recreated");
    const indexPath = join(root, ".git", "index");
    const index = await readFile(indexPath);
    const status = await repositoryStatus(root);

    expect(status.total).toBe(9);
    expect(status.files.map((file) => file.path.utf8Path).sort()).toEqual([
      "both",
      "deleted",
      "new-binary",
      "new-file",
      "rename-new",
      "restored-target",
      "staged",
      "tracked-binary",
      "unstaged",
    ]);
    expect(status.files.every((file) => file.worktree)).toBe(true);
    const byPath = new Map(
      status.files.map((entry) => [entry.path.utf8Path, entry]),
    );
    const diff = (path: string) => service.diff(root, pathId(path));
    const rows = (...lines: string[]) =>
      expect.arrayContaining(
        lines.map((text) => expect.objectContaining({ text })),
      );
    for (const [path, line] of [
      ["staged", "+staged"],
      ["unstaged", "+working"],
      ["both", "+final"],
    ] as const)
      expect(await diff(path)).toMatchObject({
        kind: "text",
        additions: 1,
        deletions: 1,
        lines: expect.arrayContaining([
          { kind: "delete", text: "-base", oldLine: 1, newLine: null },
          { kind: "add", text: line, oldLine: null, newLine: 1 },
          { kind: "context", text: " ", oldLine: 2, newLine: 2 },
          { kind: "context", text: " third", oldLine: 3, newLine: 3 },
        ]),
      });
    expect(await diff("deleted")).toMatchObject({
      kind: "text",
      additions: 0,
      deletions: 3,
    });
    expect(byPath.get("rename-new")?.worktree).toMatchObject({
      kind: "renamed",
      originalPath: { utf8Path: "rename-old" },
    });
    expect(await diff("rename-new")).toMatchObject({
      kind: "text",
      additions: 0,
      deletions: 0,
      lines: rows("rename from rename-old"),
    });
    expect(byPath.get("restored-target")?.worktree).toEqual({ kind: "added" });
    expect(await diff("restored-target")).toMatchObject({
      kind: "text",
      additions: 3,
      deletions: 0,
    });
    expect(await diff("new-file")).toMatchObject({
      kind: "text",
      additions: 2,
      deletions: 0,
      lines: rows("+new line", "+last line"),
    });
    for (const binary of ["new-binary", "tracked-binary"])
      expect(await diff(binary)).toMatchObject({ kind: "binary" });
    for (const path of ["canceled", "unknown"])
      await expect(diff(path)).rejects.toMatchObject({ status: 409 });
    await file("recreated", "replacement\n");
    const { files: replacement } = await repositoryStatus(root);
    const recreated = replacement.find(
      ({ path }) => path.utf8Path === "recreated",
    )!;
    expect(recreated.worktree).toEqual({ kind: "modified" });
    expect(await service.diff(root, recreated.path.id)).toMatchObject({
      kind: "text",
      additions: 1,
      deletions: 3,
    });
    expect(await readFile(indexPath)).toEqual(index);

    await file("rename-new", renameContents("rename staged"));
    await git("add", "rename-new");
    await file("rename-new", renameContents("rename working"));
    expect(await diff("rename-new")).toMatchObject({
      kind: "text",
      additions: 1,
      deletions: 1,
      lines: rows(
        "rename from rename-old",
        "-rename unique",
        "+rename working",
      ),
    });
  }, 20_000);

  it("parses a real merge conflict", async () => {
    const { root, git } = await repository();
    await writeFile(join(root, "conflict.txt"), "base\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const { stdout } = await git("branch", "--show-current");
    const mainBranch = stdout.trim();
    await git("checkout", "-qb", "other");
    await writeFile(join(root, "conflict.txt"), "other\n");
    await git("commit", "-qam", "other");
    await git("checkout", "-q", mainBranch);
    await writeFile(join(root, "conflict.txt"), "main\n");
    await git("commit", "-qam", "main");
    await expect(git("merge", "other")).rejects.toBeDefined();

    const status = await repositoryStatus(root);
    const conflict = status.files.find(
      (file) => file.path.utf8Path === "conflict.txt",
    )!;
    expect(conflict.conflict).toEqual({ code: "UU" });
    await expect(service.diff(root, conflict.path.id)).resolves.toMatchObject({
      kind: "conflict",
      code: "UU",
    });
  });
});
