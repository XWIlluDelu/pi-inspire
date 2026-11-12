import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename as renamePath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GIT_TIMEOUT_MS,
  GitInspectionError,
  GitInspectionService,
  type GitRunner,
  parsePorcelainV2,
  parseUnifiedDiff,
  spawnGit,
} from "../../server/git-inspection.js";

const exec = promisify(execFile);
const hash = "0123456789012345678901234567890123456789";
const headers = (head = "main", oid = hash) => [
  Buffer.from(`# branch.oid ${oid}`),
  Buffer.from(`# branch.head ${head}`),
];
const ordinary = (xy: string, sub: string, path: Buffer) =>
  Buffer.concat([
    Buffer.from(`1 ${xy} ${sub} 100644 100644 100644 ${hash} ${hash} `),
    path,
  ]);
const statusBuffer = (...records: Buffer[]) =>
  Buffer.concat(records.flatMap((record) => [record, Buffer.from([0])]));

function runnerForStatus(
  output: Buffer,
  extra?: (
    args: readonly string[],
  ) => { stdout: Buffer; truncated?: boolean } | undefined,
  netChanges = Buffer.alloc(0),
) {
  const outputs = new Map([
    ["--is-inside-work-tree", Buffer.from("true\n")],
    ["--show-toplevel", Buffer.from("/repo\n")],
    ["--show-prefix", Buffer.from("\n")],
    ["status", output],
    ["--name-status", netChanges],
  ]);
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push([...args]);
    const key = args.find((arg) => outputs.has(arg));
    const result = key
      ? { stdout: outputs.get(key)!, truncated: false }
      : extra?.(args);
    if (!result) throw new Error(`unexpected Git call: ${args.join(" ")}`);
    return {
      stdout: result.stdout,
      stderr: Buffer.alloc(0),
      truncated: result.truncated ?? false,
      code: 0,
    };
  };
  return { runner, calls };
}

describe("porcelain-v2 parser", () => {
  it("keeps one raw-byte identity with simultaneous facets and safe workspace mapping", () => {
    const path = Buffer.from("nested/space tab\tline\nname.txt");
    const invalid = Buffer.from([0x62, 0x61, 0x64, 0xff]);
    const parsed = parsePorcelainV2(
      statusBuffer(
        ...headers(),
        ordinary("MM", "N...", path),
        Buffer.concat([Buffer.from("? "), invalid]),
        ordinary(".D", "N...", Buffer.from("deleted.txt")),
      ),
      Buffer.from("nested/"),
    );
    const both = parsed.response.files[0]!;
    expect(both.path.id).toBe(path.toString("base64url"));
    expect(both.path.workspacePath).toBe("space tab\tline\nname.txt");
    expect(both.path.display).toBe("nested/space tab\\tline\\nname.txt");
    expect(both).toMatchObject({
      staged: { kind: "modified" },
      unstaged: { kind: "modified" },
    });
    const arbitrary = parsed.response.files[1]!;
    expect(arbitrary.path.id).toBe(invalid.toString("base64url"));
    expect(arbitrary.path.utf8Path).toBeUndefined();
    expect(arbitrary.path.display).toBe("bad\\xff");
    expect(parsed.response.files[2]?.unstaged).toEqual({ kind: "deleted" });
  });

  it("keeps both paths of a copied entry", () => {
    const copy = Buffer.from(
      `2 C. N... 100644 100644 100644 ${hash} ${hash} C075 copied name`,
    );
    const { response } = parsePorcelainV2(
      statusBuffer(...headers(), copy, Buffer.from("source name")),
    );
    expect(response.files[0]).toMatchObject({
      path: { utf8Path: "copied name" },
      staged: { kind: "copied", originalPath: { utf8Path: "source name" } },
    });
  });

  it("rejects malformed, duplicate and truncated status wholesale", () => {
    expect(() => parsePorcelainV2(Buffer.from("# branch.oid x\0"))).toThrow(
      /branch identity/,
    );
    expect(() =>
      parsePorcelainV2(
        statusBuffer(
          ...headers(),
          ordinary(".M", "N...", Buffer.from("a")),
          ordinary(".M", "N...", Buffer.from("a")),
        ),
      ),
    ).toThrow(/duplicate path/);
    expect(() =>
      parsePorcelainV2(
        Buffer.concat([statusBuffer(...headers()), Buffer.from("? partial")]),
      ),
    ).toThrow(/incomplete/);
  });

  it("accepts paired tracking data and rejects malformed, incomplete or duplicate branch identity", () => {
    const upstream = "# branch.upstream origin/main";
    const counts = "# branch.ab +12 -3";
    const parse = (...tracking: string[]) =>
      parsePorcelainV2(
        statusBuffer(
          ...headers(),
          ...tracking.map((value) => Buffer.from(value)),
        ),
      );
    expect(parse(upstream, counts).response.head).toMatchObject({
      kind: "branch",
      name: "main",
    });
    for (const tracking of [
      [upstream],
      [counts],
      [upstream, upstream, counts],
      [upstream, counts, counts],
      [upstream, "# branch.ab +? -1"],
      [upstream, "# branch.ab +1 -2 trailing"],
      [upstream, "# branch.ab +9007199254740992 -0"],
      ["# branch.upstream bad\x1fref", counts],
      [`# branch.upstream ${"a".repeat(4_097)}`, counts],
      [`# branch.oid ${hash}`],
      ["# branch.head other"],
    ]) {
      expect(() => parse(...tracking), tracking.join(" / ")).toThrow();
    }
    expect(() =>
      parsePorcelainV2(statusBuffer(...headers("bad\nhead"))),
    ).toThrow(/branch/);
  });

  it("rejects invalid facets, conflict codes, and mismatched rename or copy metadata", () => {
    const type2 = (xy: string, score: string) =>
      Buffer.from(
        `2 ${xy} N... 100644 100644 100644 ${hash} ${hash} ${score} destination`,
      );
    const file = Buffer.from("file");
    const source = Buffer.from("source");
    for (const record of [
      ordinary("..", "N...", file),
      ordinary(".U", "N...", file),
    ]) {
      expect(() =>
        parsePorcelainV2(statusBuffer(...headers(), record)),
      ).toThrow(/facets/);
    }
    for (const [xy, score] of [
      ["..", "R100"],
      ["M.", "R100"],
      ["R.", "C100"],
      ["R.", "R101"],
      ["RC", "R050"],
    ]) {
      expect(() =>
        parsePorcelainV2(
          statusBuffer(...headers(), type2(xy!, score!), source),
        ),
      ).toThrow();
    }
    const invalidConflict = Buffer.from(
      `u AD N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} conflict`,
    );
    expect(() =>
      parsePorcelainV2(statusBuffer(...headers(), invalidConflict)),
    ).toThrow(/conflict/);
  });
});

describe("bounded diff contract", () => {
  it("caps visible status after excluding canceled index edits", async () => {
    const canceled = Array.from({ length: 1_005 }, (_, index) =>
      ordinary("MM", "N...", Buffer.from(`tracked-${index}`)),
    );
    const untracked = Array.from({ length: 1_001 }, (_, index) =>
      Buffer.from(`? untracked-${index}`),
    );
    const status = statusBuffer(...headers(), ...canceled, ...untracked);
    const runner = runnerForStatus(
      status,
      undefined,
      Buffer.from("M\0tracked-1004\0"),
    );
    const result = await new GitInspectionService(runner.runner).status(
      "/workspace",
    );
    expect(result).toMatchObject({
      kind: "repository",
      total: 1_002,
      truncated: true,
    });
    if (result.kind !== "repository") throw new Error("Expected repository");
    expect(result.files).toHaveLength(1_000);
    expect(
      result.files.find(({ path }) => path.utf8Path === "tracked-1004"),
    ).toMatchObject({
      worktree: { kind: "modified" },
    });
    expect(result.files.filter(({ untracked }) => untracked)).toHaveLength(999);
  });

  it("distinguishes marker-like hunk content from the next file's headers", () => {
    const parsed = parseUnifiedDiff(
      Buffer.from(
        [
          "--- a/first.md",
          "+++ b/first.md",
          "@@ -2,3 +2,3 @@",
          " before",
          "----",
          "++++",
          " after",
          "\\ No newline at end of file",
          "--- a/second.md",
          "+++ b/second.md",
          "@@ -0,0 +1 @@",
          "+new",
        ].join("\n"),
      ),
    );
    expect(
      parsed.lines.map(({ kind, oldLine, newLine }) => [
        kind,
        oldLine,
        newLine,
      ]),
    ).toEqual([
      ["meta", null, null],
      ["meta", null, null],
      ["hunk", null, null],
      ["context", 2, 2],
      ["delete", 3, null],
      ["add", null, 3],
      ["context", 4, 4],
      ["meta", null, null],
      ["meta", null, null],
      ["meta", null, null],
      ["hunk", null, null],
      ["add", null, 1],
    ]);
  });

  it("caps the projected diff line cardinality through the service contract", async () => {
    const path = Buffer.from("many.txt");
    const patch = Buffer.from(
      [
        "--- a/many.txt",
        "+++ b/many.txt",
        "@@ -1,2100 +1,2100 @@",
        ...Array.from({ length: 2_100 }, (_, index) => ` line-${index}`),
        "",
      ].join("\n"),
    );
    const fake = runnerForStatus(
      statusBuffer(...headers(), ordinary(".M", "N...", path)),
      (args) =>
        args.includes("--numstat")
          ? { stdout: Buffer.from("2100\t2100\tmany.txt\0") }
          : { stdout: patch },
      Buffer.from("M\0many.txt\0"),
    );
    const result = await new GitInspectionService(fake.runner).diff(
      "/workspace",
      path.toString("base64url"),
    );
    expect(result).toMatchObject({ kind: "text", truncated: true });
    if (result.kind === "text") {
      expect(result.lines).toHaveLength(2_000);
      expect(result.lines.at(-1)).toMatchObject({
        kind: "meta",
        text: expect.stringContaining("projected lines"),
      });
    }
  });

  it("distinguishes opaque paths, empty comparisons and truncated patches", async () => {
    const invalid = Buffer.from([0xff]);
    const unsupported = runnerForStatus(
      statusBuffer(...headers(), ordinary(".M", "N...", invalid)),
      undefined,
      Buffer.concat([Buffer.from("M\0"), invalid, Buffer.from([0])]),
    );
    expect(
      await new GitInspectionService(unsupported.runner).diff(
        "/w",
        invalid.toString("base64url"),
      ),
    ).toMatchObject({ kind: "unsupported", reason: "path-encoding" });

    const textPath = Buffer.from("empty.txt");
    const empty = runnerForStatus(
      statusBuffer(...headers(), ordinary(".M", "N...", textPath)),
      () => ({ stdout: Buffer.alloc(0) }),
      Buffer.from("M\0empty.txt\0"),
    );
    expect(
      await new GitInspectionService(empty.runner).diff(
        "/w",
        textPath.toString("base64url"),
      ),
    ).toMatchObject({ kind: "empty" });

    const truncated = runnerForStatus(
      statusBuffer(...headers(), ordinary(".M", "N...", textPath)),
      (args) =>
        args.includes("--numstat")
          ? { stdout: Buffer.from("1\t1\tempty.txt\0") }
          : {
              stdout: Buffer.from("@@ -1 +1 @@\n-old\n+partial"),
              truncated: true,
            },
      Buffer.from("M\0empty.txt\0"),
    );
    const truncatedResult = await new GitInspectionService(
      truncated.runner,
    ).diff("/w", textPath.toString("base64url"));
    expect(truncatedResult).toMatchObject({ kind: "text", truncated: true });
    if (truncatedResult.kind === "text") {
      expect(truncatedResult.lines.at(-1)?.text).toContain("truncated");
      expect(
        truncatedResult.lines.some(({ text }) => text === "+partial"),
      ).toBe(false);
    }
  });

  it.runIf(process.platform !== "win32")(
    "sanitizes environment and kills hostile descendant groups on cap, timeout, and abort",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inspire-fake-git-"));
      const marker = join(directory, "descendant-alive");
      try {
        const childCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), Number(process.argv[1]))`;
        await writeFile(
          join(directory, "git"),
          `#!${process.execPath}\nconst { spawn } = require("node:child_process");\nconst mode = process.argv[2];\nconst childCode = ${JSON.stringify(childCode)};\nconst descendant = (delay) => spawn(process.execPath, ["-e", childCode, String(delay)], { stdio: "ignore" });\nif (mode === "env") process.stdout.write(JSON.stringify({ GIT_DIR: process.env.GIT_DIR, GIT_ASKPASS: process.env.GIT_ASKPASS, GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF, SSH_ASKPASS: process.env.SSH_ASKPASS, LD_PRELOAD: process.env.LD_PRELOAD }));\nelse if (mode === "slow") { descendant(4500); setTimeout(() => {}, 10_000); }\nelse if (mode === "cap") { descendant(500); process.stdout.write(Buffer.alloc(64, 120)); setTimeout(() => {}, 10_000); }\nelse if (mode === "abort") { descendant(500); setTimeout(() => {}, 10_000); }\nelse if (mode === "stderr") process.stderr.write(Buffer.alloc(64, 120));\nelse process.stdout.write(Buffer.alloc(64, 120));\n`,
          { mode: 0o755 },
        );
        vi.stubEnv("PATH", directory);
        for (const key of [
          "GIT_DIR",
          "GIT_ASKPASS",
          "GIT_EXTERNAL_DIFF",
          "SSH_ASKPASS",
          "LD_PRELOAD",
        ]) {
          vi.stubEnv(key, join(directory, "must-not-pass"));
        }

        const sanitized = await spawnGit(["env"], { stdoutLimit: 1_024 });
        expect(JSON.parse(sanitized.stdout.toString("utf8"))).toEqual({});
        await expect(
          spawnGit(["stderr"], { stdoutLimit: 32, stderrLimit: 32 }),
        ).rejects.toThrow(/output exceeded/);

        await expect(spawnGit(["cap"], { stdoutLimit: 32 })).rejects.toThrow(
          /output exceeded/,
        );
        await delay(700);
        await expect(access(marker)).rejects.toThrow();

        const controller = new AbortController();
        const aborted = spawnGit(["abort"], {
          stdoutLimit: 32,
          signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 50);
        await expect(aborted).rejects.toMatchObject({
          status: 499,
          message: "Git inspection was cancelled",
        });
        await delay(700);
        await expect(access(marker)).rejects.toThrow();

        await expect(
          spawnGit(["slow"], { stdoutLimit: 32 }),
        ).rejects.toMatchObject({
          status: 503,
          message: "Git inspection timed out",
        });
        await delay(700);
        await expect(access(marker)).rejects.toThrow();

        const partial = await spawnGit(["big"], {
          stdoutLimit: 32,
          allowStdoutTruncation: true,
        });
        expect(partial).toMatchObject({ truncated: true });
        expect(partial.stdout).toHaveLength(32);
      } finally {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    },
    GIT_TIMEOUT_MS + 8_000,
  );

  it("rejects IDs outside the status result and preserves operational failures", async () => {
    const path = Buffer.from("safe.txt");
    const fixture = statusBuffer(...headers(), ordinary(".M", "N...", path));
    const fake = runnerForStatus(fixture);
    await expect(
      new GitInspectionService(fake.runner).diff(
        "/w",
        Buffer.from("other").toString("base64url"),
      ),
    ).rejects.toMatchObject({ status: 409 });

    const failure: GitRunner = async () => {
      throw new GitInspectionError("Git inspection timed out", 503);
    };
    await expect(
      new GitInspectionService(failure).status("/w"),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe("real temporary repository", () => {
  const directories: string[] = [];
  afterEach(async () =>
    Promise.all(
      directories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    ),
  );

  async function repository() {
    const root = await mkdtemp(join(tmpdir(), "inspire-git-"));
    directories.push(root);
    const git = (...args: string[]) => exec("git", ["-C", root, ...args]);
    await git("init", "-q");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "user.name", "Test");
    return { root, git };
  }

  it("accepts Git's paired unknown ahead/behind tracking header through the real service", async () => {
    const origin = await mkdtemp(join(tmpdir(), "inspire-tracking-origin-"));
    directories.push(origin);
    await exec("git", ["init", "-q", "--bare", origin]);
    const { root, git } = await repository();
    await writeFile(join(root, "tracked.txt"), "base\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await git("remote", "add", "origin", origin);
    await git("push", "-qu", "origin", "HEAD");
    await writeFile(join(root, "tracked.txt"), "local-commit\n");
    await git("commit", "-qam", "ahead");
    await writeFile(join(root, "tracked.txt"), "working-change\n");

    const status = await new GitInspectionService().status(root);
    expect(status).toMatchObject({
      kind: "repository",
      head: { kind: "branch" },
    });
    if (status.kind === "repository") {
      expect(
        status.files.find((file) => file.path.utf8Path === "tracked.txt")
          ?.unstaged?.kind,
      ).toBe("modified");
    }
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

      const service = new GitInspectionService();
      const status = await service.status(nested);
      expect(status).toMatchObject({
        kind: "repository",
        head: { kind: "detached" },
      });
      if (status.kind !== "repository") throw new Error("Expected repository");
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
      const root = await mkdtemp(join(tmpdir(), "inspire-untracked-"));
      const outside = await mkdtemp(join(tmpdir(), "inspire-outside-"));
      directories.push(root, outside);
      await exec("git", ["init", "-q", root]);
      await writeFile(join(outside, "secret"), "must-not-be-read\n");
      await symlink(join(outside, "secret"), join(root, "final-link"));
      await symlink(outside, join(root, "intermediate-link"));
      await symlink("/dev/null", join(root, "device-link"));
      await exec("mkfifo", [join(root, "named-pipe")]);
      await mkdir(join(root, "swap"));
      await writeFile(join(root, "swap", "victim"), "before-swap\n");

      const service = new GitInspectionService();
      const initial = await service.status(root);
      expect(initial.kind).toBe("repository");
      if (initial.kind !== "repository") return;
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
        bounded(
          service.diff(root, Buffer.from("named-pipe").toString("base64url")),
        ),
      ).rejects.toMatchObject({ status: 409 });

      const victim = byPath("swap/victim");
      expect(victim).toBeDefined();
      await renamePath(join(root, "swap"), join(root, "swap-original"));
      await symlink(outside, join(root, "swap"));
      await expect(
        bounded(service.diff(root, victim.path.id)),
      ).rejects.toMatchObject({ status: 409 });
    },
  );

  it("shows one HEAD-to-worktree change per file, including staged edits and untracked files", async () => {
    const { root, git } = await repository();
    for (const path of [
      "staged",
      "unstaged",
      "both",
      "canceled",
      "deleted",
      "rename-old",
      "restored-source",
      "recreated",
    ])
      await writeFile(
        join(root, path),
        path === "rename-old"
          ? "rename unique\nsecond rename\nthird rename\n"
          : path === "deleted"
            ? "deleted unique\nsecond deleted\nthird deleted\n"
            : "base\nsecond\nthird\n",
      );
    await writeFile(join(root, "tracked-binary"), Buffer.from([0, 1]));
    await git("add", ".");
    await git("commit", "-qm", "base");
    await writeFile(join(root, "tracked-binary"), Buffer.from([0, 1, 2]));
    const base = "base\nsecond\nthird\n";
    await writeFile(join(root, "staged"), "staged\nsecond\nthird\n");
    await writeFile(join(root, "both"), "staged\nsecond\nthird\n");
    await writeFile(join(root, "canceled"), "staged\nsecond\nthird\n");
    await git("add", "staged", "both", "canceled");
    await writeFile(join(root, "unstaged"), "working\nsecond\nthird\n");
    await writeFile(join(root, "both"), "final\nsecond\nthird\n");
    await writeFile(join(root, "canceled"), base);
    await rm(join(root, "deleted"));
    await git("mv", "rename-old", "rename-new");
    await git("mv", "restored-source", "restored-target");
    await writeFile(join(root, "restored-source"), base);
    await writeFile(join(root, "new-file"), "new line\nlast line");
    await writeFile(join(root, "new-binary"), Buffer.from([0, 1, 2]));
    // A removed index entry with the original file still on disk is another
    // legitimate cancellation; porcelain emits both D and ? for this identity.
    await git("rm", "--cached", "recreated");
    const indexBefore = await readFile(join(root, ".git", "index"));
    const service = new GitInspectionService();
    const status = await service.status(root);
    expect(status.kind).toBe("repository");
    if (status.kind !== "repository") return;

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
    const byPath = (path: string) =>
      status.files.find((file) => file.path.utf8Path === path)!;
    const diff = (path: string) => service.diff(root, byPath(path).path.id);
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
        lines: rows("-base", line),
      });
    expect(await diff("deleted")).toMatchObject({
      kind: "text",
      additions: 0,
      deletions: 3,
    });
    expect(byPath("rename-new").worktree).toMatchObject({
      kind: "renamed",
      originalPath: { utf8Path: "rename-old" },
    });
    expect(await diff("rename-new")).toMatchObject({
      kind: "text",
      additions: 0,
      deletions: 0,
      lines: rows("rename from rename-old"),
    });
    expect(byPath("restored-target").worktree).toEqual({ kind: "added" });
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
    await expect(
      service.diff(root, Buffer.from("canceled").toString("base64url")),
    ).rejects.toMatchObject({ status: 409 });
    await writeFile(join(root, "recreated"), "replacement\n");
    const replaced = await service.status(root);
    expect(replaced.kind).toBe("repository");
    if (replaced.kind === "repository") {
      const file = replaced.files.find(
        (file) => file.path.utf8Path === "recreated",
      )!;
      expect(file.worktree).toEqual({ kind: "modified" });
      expect(await service.diff(root, file.path.id)).toMatchObject({
        kind: "text",
        additions: 1,
        deletions: 3,
      });
    }
    const indexAfter = await readFile(join(root, ".git", "index"));
    expect(indexAfter.equals(indexBefore)).toBe(true);

    const renameFile = join(root, "rename-new");
    await writeFile(renameFile, "rename staged\nsecond rename\nthird rename\n");
    await git("add", "rename-new");
    await writeFile(
      renameFile,
      "rename working\nsecond rename\nthird rename\n",
    );
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

  it("uses an empty baseline before the first commit and omits newly staged files removed again", async () => {
    const { root, git } = await repository();
    await writeFile(join(root, "staged"), "staged\n");
    await writeFile(join(root, "gone"), "gone\n");
    await git("add", ".");
    await writeFile(join(root, "staged"), "final\n");
    await rm(join(root, "gone"));
    await writeFile(join(root, "untracked"), "new\n");
    await writeFile(join(root, "empty"), "");
    const service = new GitInspectionService();
    const status = await service.status(root);
    expect(status).toMatchObject({
      kind: "repository",
      head: { kind: "unborn" },
      total: 3,
    });
    if (status.kind !== "repository") return;
    for (const file of status.files) {
      expect(file.worktree).toEqual({ kind: "added" });
      const diff = await service.diff(root, file.path.id);
      expect(diff).toMatchObject({
        kind: "text",
        additions: file.path.utf8Path === "empty" ? 0 : 1,
        deletions: 0,
      });
    }
  });

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

    const service = new GitInspectionService();
    const status = await service.status(root);
    expect(status.kind).toBe("repository");
    if (status.kind !== "repository") return;
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
