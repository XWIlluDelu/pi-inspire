import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitInspectionService } from "../../server/git-inspection.js";
import {
  createGitInspectionRunner,
  GIT_CONFIG_ARGS,
  type GitRunOptions,
} from "../../server/git-runner.js";

const exec = promisify(execFile);
const directories: string[] = [];
const textId = Buffer.from("text.txt").toString("base64url");
const quote = (value: string) =>
  "'" + value.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function configuredGit(
  cwd: string,
  args: string[],
  options: GitRunOptions,
) {
  const runner = createGitInspectionRunner(cwd);
  try {
    return await runner(args, options);
  } finally {
    await runner.close();
  }
}

async function configuredRepository() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-git-configuration-")),
  );
  directories.push(directory);
  const root = join(directory, "repo"),
    home = join(directory, "home");
  const xdg = join(home, ".config"),
    system = join(directory, "system.gitconfig");
  await mkdir(root);
  await mkdir(join(xdg, "git"), { recursive: true });
  await writeFile(system, "");
  for (const key of Object.keys(process.env))
    if (/^GIT_/iu.test(key)) vi.stubEnv(key, undefined);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", xdg);
  vi.stubEnv("GIT_CONFIG_SYSTEM", system);
  const git = (...args: string[]) => exec("git", ["-C", root, ...args]);
  await git("init", "-q");
  const file = join(root, "text.txt");
  const stage = async (content = "first\r\nsecond\r\n") => {
    await writeFile(file, content);
    await git("add", "text.txt");
    // Force content comparison instead of relying on the index's stat shortcut.
    await utimes(file, new Date(), new Date(Date.now() + 2_000));
  };
  return {
    directory,
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
  const f = await configuredRepository();
  await writeFile(f.global, "[core]\n autocrlf = true\n");
  await f.stage("parent\n");
  const identity = [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
  ];
  await f.git(...identity, "commit", "-qm", "parent");
  await f.git("config", "core.autocrlf", "false");
  const origin = join(f.directory, "module-origin");
  await mkdir(origin);
  const originGit = (...args: string[]) => exec("git", ["-C", origin, ...args]);
  await originGit("init", "-q");
  await writeFile(join(origin, "text.txt"), "first\r\nsecond\r\n");
  await originGit("add", ".");
  await originGit(...identity, "commit", "-qm", "module");
  await f.git(
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    origin,
    "module",
  );
  await f.git(...identity, "commit", "-qm", "module pointer");
  const module = join(f.root, "module");
  const moduleGit = (...args: string[]) => exec("git", ["-C", module, ...args]);
  await moduleGit("config", "core.autocrlf", "true");
  return { ...f, module, moduleGit, identity };
}

describe("effective safe Git configuration in real repositories", () => {
  it.each(["system", "home", "xdg", "implicit boolean"] as const)(
    "keeps %s EOL semantics in status and diffs without updating the index",
    async (source) => {
      const f = await configuredRepository();
      const configuration =
        source === "system"
          ? f.system
          : source === "xdg"
            ? join(f.xdg, "git", "config")
            : f.global;
      await writeFile(
        configuration,
        source === "implicit boolean"
          ? "[core]\n autocrlf\n"
          : "[core]\n autocrlf = true\n",
      );
      await f.stage();
      expect((await f.git("status", "--porcelain=v2")).stdout).toMatch(
        /1 A\. /u,
      );
      const index = await readFile(join(f.root, ".git", "index"));
      const service = new GitInspectionService(),
        status = await service.status(f.root);
      expect(status.kind).toBe("repository");
      if (status.kind !== "repository") throw new Error("Expected repository");
      expect(status.files).toHaveLength(1);
      expect(status.files[0]!.staged).toEqual({ kind: "added" });
      expect(status.files[0]!.unstaged).toBeUndefined();
      expect(await service.diff(f.root, textId, "staged")).toMatchObject({
        kind: "text",
        additions: 2,
        deletions: 0,
      });
      await writeFile(f.file, "other\r\nsecond\r\n");
      expect(await service.diff(f.root, textId, "unstaged")).toMatchObject({
        kind: "text",
        additions: 1,
        deletions: 1,
      });
      expect(await readFile(join(f.root, ".git", "index"))).toEqual(index);
    },
    15_000,
  );

  it("preserves conditional includes, repository/worktree overrides and attributes on every refresh", async () => {
    const f = await configuredRepository();
    await writeFile(f.system, "[core]\n autocrlf = true\n");
    await writeFile(
      join(f.xdg, "git", "config"),
      "[core]\n autocrlf = false\n",
    );
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
    const service = new GitInspectionService();
    let comparisons = 0;
    const unstaged = async () => {
      // A config edit does not invalidate Git's cached clean stat by itself.
      await utimes(
        f.file,
        new Date(),
        new Date(Date.now() + ++comparisons * 2_000),
      );
      const normal = (await f.git("status", "--porcelain=v2")).stdout;
      const status = await service.status(f.root);
      if (status.kind !== "repository") throw new Error("Expected repository");
      const file = status.files.find(
        (file) => file.path.utf8Path === "text.txt",
      )!;
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

  it.each(["default", "explicit", "native Unicode path"] as const)(
    "keeps %s global attributes and excludes as data",
    async (mode) => {
      const f = await configuredRepository();
      const attributes =
        mode === "default"
          ? join(f.xdg, "git", "attributes")
          : join(f.home, "attributes own-研究");
      const excludes =
        mode === "default"
          ? join(f.xdg, "git", "ignore")
          : join(f.home, "ignore own-研究");
      await writeFile(attributes, "text.txt text eol=crlf\n");
      await writeFile(excludes, "globally-ignored.txt\n");
      await writeFile(
        f.global,
        mode === "default"
          ? "[core]\n autocrlf = false\n"
          : mode === "explicit"
            ? '[core]\n autocrlf = false\n attributesFile = "~/attributes own-研究"\n excludesFile = "~/ignore own-研究"\n'
            : "[core]\n autocrlf = false\n attributesFile = " +
              JSON.stringify(attributes) +
              "\n excludesFile = " +
              JSON.stringify(excludes) +
              "\n",
      );
      await f.stage();
      await writeFile(join(f.root, "globally-ignored.txt"), "hidden\n");
      await writeFile(join(f.root, "visible.txt"), "visible\n");
      const normal = (await f.git("status", "--porcelain=v2")).stdout;
      expect(normal).toMatch(/1 A\. /u);
      expect(normal).not.toContain("globally-ignored.txt");
      const status = await new GitInspectionService().status(f.root);
      if (status.kind !== "repository") throw new Error("Expected repository");
      expect(status.files.map((file) => file.path.utf8Path)).toEqual([
        "text.txt",
        "visible.txt",
      ]);
      expect(status.files[0]!.unstaged).toBeUndefined();
    },
    15_000,
  );

  it("only promotes safe.directory from protected scopes, preserving ordered resets", async () => {
    const f = await configuredRepository();
    await writeFile(f.system, "[safe]\n directory = *\n");
    await writeFile(
      f.global,
      "[safe]\n directory =\n directory = " +
        JSON.stringify(f.root.replaceAll("\\", "/")) +
        "\n",
    );
    await f.git("config", "safe.directory", "/repository-must-not-be-promoted");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "safe.directory");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "/explicit-command");
    const result = await configuredGit(
      f.root,
      [
        ...GIT_CONFIG_ARGS,
        "-C",
        f.root,
        "config",
        "--null",
        "--show-scope",
        "--get-all",
        "safe.directory",
      ],
      { stdoutLimit: 64 * 1024 },
    );
    const fields = result.stdout.toString("utf8").split("\0").slice(0, -1);
    const commandValues = [],
      globalValues = [];
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] === "command") commandValues.push(fields[i + 1]);
      if (fields[i] === "global") globalValues.push(fields[i + 1]);
    }
    expect(commandValues).toEqual(["/explicit-command"]);
    expect(globalValues).toEqual(["*", "", f.root.replaceAll("\\", "/")]);
    expect(fields).toContain("local");
    expect(fields).toContain("/repository-must-not-be-promoted");
  });

  it("accepts an empty selection and ignores config-only GIT_CONFIG authority", async () => {
    const f = await configuredRepository();
    const empty = await configuredGit(
      f.directory,
      [...GIT_CONFIG_ARGS, "--version"],
      { stdoutLimit: 1_024 },
    );
    expect(empty.stdout.toString("utf8")).toMatch(/^git version /u);
    await writeFile(f.global, "[core]\n autocrlf = true\n");
    await f.stage();
    const unrelated = join(f.directory, "config-only");
    await writeFile(unrelated, "[core]\n autocrlf = false\n");
    vi.stubEnv("GIT_CONFIG", unrelated); // Only the config subcommand honors this variable.
    const status = await new GitInspectionService().status(f.root);
    if (status.kind !== "repository") throw new Error("Expected repository");
    expect(status.files[0]!.unstaged).toBeUndefined();
  });

  it("projects EOL overrides but never hooks, external diff, textconv or injected Git authority", async () => {
    const f = await configuredRepository();
    await writeFile(f.global, "[core]\n autocrlf = true\n");
    await f.stage();
    const marker = join(f.directory, "command-ran"),
      program = join(f.directory, "probe.cjs");
    await writeFile(
      program,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.stdout.write("converted\\n");`,
    );
    const command = quote(process.execPath) + " " + quote(program);
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
    const result = await new GitInspectionService().diff(
      f.root,
      textId,
      "unstaged",
    );
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
    ["repository", "clean"],
    ["global", "process"],
    ["repository", "process"],
  ] as const)(
    "blocks an actually used %s %s filter without rejecting unrelated files",
    async (scope, method) => {
      const f = await configuredRepository();
      await f.stage("before\n");
      const marker = join(f.directory, "filter-ran"),
        program = join(f.directory, "filter.cjs");
      await writeFile(
        program,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); ` +
          (method === "clean"
            ? "process.stdin.pipe(process.stdout);"
            : "process.exit(1);"),
      );
      const command = quote(process.execPath) + " " + quote(program);
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
      const service = new GitInspectionService();
      await expect(service.status(f.root)).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("External content filters"),
        detail: expect.stringContaining("clean filter 'Owned.Driver' failed"),
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      // A size change lets status skip hashing; diff must still block conversion.
      await writeFile(f.file, "different-sized content\n");
      expect((await service.status(f.root)).kind).toBe("repository");
      await expect(
        service.diff(f.root, textId, "unstaged"),
      ).rejects.toMatchObject({
        status: 422,
        detail: expect.stringContaining("clean filter 'Owned.Driver' failed"),
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(
        join(f.root, ".gitattributes"),
        "*.asset filter=Owned.Driver\n",
      );
      expect(await service.diff(f.root, textId, "unstaged")).toMatchObject({
        kind: "text",
        additions: 1,
        deletions: 1,
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
    20_000,
  );

  it("honors an explicit repository override that disables a global conversion", async () => {
    const f = await configuredRepository();
    await f.stage("before\n");
    await writeFile(f.global, '[filter "owned"]\n clean = "must-not-run"\n');
    await f.git("config", "filter.owned.clean", "");
    await writeFile(join(f.root, ".gitattributes"), "text.txt filter=owned\n");
    await writeFile(f.file, "after!\n");
    expect(
      await new GitInspectionService().diff(f.root, textId, "unstaged"),
    ).toMatchObject({
      kind: "text",
      additions: 1,
      deletions: 1,
    });
  });

  it.each(["color", "suppressBlankEmpty"] as const)(
    "keeps the machine patch grammar despite %s configuration",
    async (setting) => {
      const f = await configuredRepository();
      await f.stage("before\n\nlast\n");
      await f.git(
        "config",
        setting === "color" ? "color.diff" : "diff.suppressBlankEmpty",
        setting === "color" ? "always" : "true",
      );
      await writeFile(f.file, "after!\n\nlast\n");
      const result = await new GitInspectionService().diff(
        f.root,
        textId,
        "unstaged",
      );
      expect(result).toMatchObject({
        kind: "text",
        additions: 1,
        deletions: 1,
      });
      if (result.kind !== "text") throw new Error("Expected text diff");
      expect(result.lines).toEqual(
        expect.arrayContaining([
          { kind: "delete", text: "-before", oldLine: 1, newLine: null },
          { kind: "add", text: "+after!", oldLine: null, newLine: 1 },
          { kind: "context", text: " ", oldLine: 2, newLine: 2 },
          { kind: "context", text: " last", oldLine: 3, newLine: 3 },
        ]),
      );
      expect(
        result.lines.some((line) =>
          line.text.includes(String.fromCharCode(27)),
        ),
      ).toBe(false);
    },
  );

  it("preserves root/child local EOL differences and real submodule commit/dirty/untracked states", async () => {
    const f = await repositoryWithSubmodule();
    const file = join(f.module, "text.txt");
    await utimes(file, new Date(), new Date(Date.now() + 2_000));
    expect((await f.git("status", "--porcelain=v2")).stdout).toBe("");
    await utimes(file, new Date(), new Date(Date.now() + 4_000));
    const service = new GitInspectionService();
    const state = async () => {
      const response = await service.status(f.root);
      if (response.kind !== "repository")
        throw new Error("Expected repository");
      return response.files;
    };
    expect(await state()).toEqual([]);
    await writeFile(join(f.module, "untracked.txt"), "untracked\n");
    expect(await state()).toEqual([
      expect.objectContaining({
        submodule: {
          commitChanged: false,
          trackedModified: false,
          untracked: true,
        },
      }),
    ]);
    await writeFile(file, "other\r\nsecond\r\n");
    expect(await state()).toEqual([
      expect.objectContaining({
        submodule: {
          commitChanged: false,
          trackedModified: true,
          untracked: true,
        },
      }),
    ]);
    await f.moduleGit("add", "text.txt");
    await f.moduleGit(...f.identity, "commit", "-qm", "new module head");
    expect(await state()).toEqual([
      expect.objectContaining({
        submodule: {
          commitChanged: true,
          trackedModified: false,
          untracked: true,
        },
      }),
    ]);
  }, 30_000);

  it.each(["root", "module"] as const)(
    "blocks an owned %s driver during recursive status without hiding submodule dirtiness",
    async (location) => {
      const f = await repositoryWithSubmodule();
      const workspace = location === "root" ? f.root : f.module;
      const git = location === "root" ? f.git : f.moduleGit;
      const marker = join(f.directory, "recursive-filter-ran");
      const program = join(f.directory, "recursive-filter.cjs");
      await writeFile(
        program,
        "require('node:fs').writeFileSync(" +
          JSON.stringify(marker) +
          ", 'ran'); process.stdin.pipe(process.stdout);",
      );
      const command = quote(process.execPath) + " " + quote(program);
      await git("config", "filter.Recursive.clean", command);
      await writeFile(
        join(workspace, ".gitattributes"),
        "text.txt filter=Recursive\n",
      );
      const file = join(workspace, "text.txt");
      await writeFile(
        file,
        location === "root" ? "after!\n" : "other\r\nsecond\r\n",
      );
      await utimes(file, new Date(), new Date(Date.now() + 2_000));
      await f.git("status", "--porcelain=v2");
      await access(marker);
      await rm(marker);
      // The ordinary probe may cache a clean stat; force content comparison again.
      await utimes(file, new Date(), new Date(Date.now() + 4_000));
      const service = new GitInspectionService();
      await expect(service.status(f.root)).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining("External content filters"),
      });
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(
        join(workspace, ".gitattributes"),
        "*.asset filter=Recursive\n",
      );
      const response = await service.status(f.root);
      if (response.kind !== "repository")
        throw new Error("Expected repository");
      expect(response.files.some((file) => file.unstaged)).toBe(true);
      if (location === "module")
        expect(response.files[0]!.submodule?.trackedModified).toBe(true);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
    30_000,
  );

  it("rejects differing conditional global settings instead of contaminating child semantics", async () => {
    const f = await repositoryWithSubmodule();
    await writeFile(join(f.home, "root-only"), "[core]\n safecrlf = true\n");
    await writeFile(
      f.global,
      "[core]\n autocrlf = true\n" +
        '[includeIf "gitdir:' +
        f.root.replaceAll("\\", "/") +
        '/.git"]\n path = root-only\n',
    );
    await expect(
      new GitInspectionService().status(f.root),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("conditional submodule settings"),
    });
  }, 30_000);

  it("never lazily fetches missing objects through a configured upload-pack program", async () => {
    const f = await configuredRepository();
    await f.stage("before\n");
    const object = (await f.git("rev-parse", ":text.txt")).stdout.trim();
    await rm(
      join(f.root, ".git", "objects", object.slice(0, 2), object.slice(2)),
    );
    const marker = join(f.directory, "uploadpack-ran");
    const program = join(f.directory, "uploadpack.cjs");
    await writeFile(
      program,
      "require('node:fs').writeFileSync(" +
        JSON.stringify(marker) +
        ", 'ran'); process.exit(1);",
    );
    await f.git("config", "remote.owned.url", f.root);
    await f.git("config", "remote.owned.promisor", "true");
    await f.git(
      "config",
      "remote.owned.uploadpack",
      quote(process.execPath) + " " + quote(program),
    );
    // Control: ordinary Git really invokes the owned helper for this missing blob.
    await f
      .git("diff", "--cached", "--no-ext-diff", "--no-textconv")
      .catch(() => undefined);
    await access(marker);
    await rm(marker);
    await expect(
      new GitInspectionService().diff(f.root, textId, "staged"),
    ).rejects.toMatchObject({
      status: 502,
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("keeps the safe file alive across parallel queries and removes it after success or failure", async () => {
    const f = await configuredRepository();
    await writeFile(f.global, "[core]\n autocrlf = true\n");
    const runner = createGitInspectionRunner(f.root);
    let path: string | undefined;
    try {
      const [first, second] = await Promise.all(
        [1, 2].map(() =>
          runner(
            [
              ...GIT_CONFIG_ARGS,
              "-C",
              f.root,
              "config",
              "--null",
              "--show-origin",
              "--get",
              "core.autocrlf",
            ],
            { stdoutLimit: 4_096 },
          ),
        ),
      );
      expect(first!.stdout).toEqual(second!.stdout);
      const [origin, value] = first!.stdout.toString("utf8").split("\0");
      expect(value).toBe("true");
      path = origin!.slice("file:".length);
      await access(path);
      await expect(
        runner(
          [
            ...GIT_CONFIG_ARGS,
            "-C",
            f.root,
            "rev-parse",
            "--verify",
            "refs/heads/not-created",
          ],
          { stdoutLimit: 1_024 },
        ),
      ).rejects.toMatchObject({ status: 502 });
      await access(path);
    } finally {
      await runner.close();
    }
    await expect(access(path!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails bounded config reads and propagates cancellation rather than dropping settings", async () => {
    const f = await configuredRepository(),
      service = new GitInspectionService();
    await writeFile(f.global, "[core]\n" + " autocrlf = true\n".repeat(4_000));
    await expect(service.status(f.root)).rejects.toThrow(/output exceeded/u);
    await writeFile(f.global, "[core\n");
    await expect(service.status(f.root)).rejects.toMatchObject({ status: 502 });
    await expect(
      service.status(f.root, AbortSignal.abort()),
    ).rejects.toMatchObject({ status: 499 });
  });
});
