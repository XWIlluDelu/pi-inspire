import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rename as renamePath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_DIFF_OUTPUT_BYTES,
  GIT_STATUS_OUTPUT_BYTES,
  GIT_STDERR_BYTES,
  GIT_TIMEOUT_MS,
  GitInspectionError,
  GitInspectionService,
  parsePorcelainV2,
  spawnGit,
  parseUnifiedDiff,
  type GitRunner,
} from "../../server/git-inspection.js";

const exec = promisify(execFile);
const hash = "0123456789012345678901234567890123456789";
const headers = (head = "main", oid = hash) => [
  Buffer.from(`# branch.oid ${oid}`),
  Buffer.from(`# branch.head ${head}`),
];
const ordinary = (xy: string, sub: string, path: Buffer) => Buffer.concat([
  Buffer.from(`1 ${xy} ${sub} 100644 100644 100644 ${hash} ${hash} `), path,
]);
const statusBuffer = (...records: Buffer[]) => Buffer.concat(records.flatMap((record) => [record, Buffer.from([0])]));

function runnerForStatus(output: Buffer, extra?: (args: readonly string[]) => { stdout: Buffer; truncated?: boolean } | undefined) {
  const calls: readonly string[][] = [];
  const runner: GitRunner = async (args) => {
    (calls as string[][]).push([...args]);
    if (args.includes("--is-inside-work-tree")) return { stdout: Buffer.from("true\n"), stderr: Buffer.alloc(0), truncated: false, code: 0 };
    if (args.includes("--show-toplevel")) return { stdout: Buffer.from("/repo\n"), stderr: Buffer.alloc(0), truncated: false, code: 0 };
    if (args.includes("--show-prefix")) return { stdout: Buffer.from("\n"), stderr: Buffer.alloc(0), truncated: false, code: 0 };
    if (args.includes("status")) return { stdout: output, stderr: Buffer.alloc(0), truncated: false, code: 0 };
    const result = extra?.(args);
    if (!result) throw new Error(`unexpected Git call: ${args.join(" ")}`);
    return { stdout: result.stdout, stderr: Buffer.alloc(0), truncated: result.truncated ?? false, code: 0 };
  };
  return { runner, calls };
}

describe("porcelain-v2 parser", () => {
  it("keeps one raw-byte identity with simultaneous facets and safe workspace mapping", () => {
    const path = Buffer.from("nested/space tab\tline\nname.txt");
    const invalid = Buffer.from([0x62, 0x61, 0x64, 0xff]);
    const parsed = parsePorcelainV2(statusBuffer(
      ...headers(),
      ordinary("MM", "N...", path),
      Buffer.concat([Buffer.from("? "), invalid]),
      ordinary(".D", "N...", Buffer.from("deleted.txt")),
    ), Buffer.from("nested/"));
    const both = parsed.response.files[0]!;
    expect(both.path.id).toBe(path.toString("base64url"));
    expect(both.path.workspacePath).toBe("space tab\tline\nname.txt");
    expect(both.path.display).toBe("nested/space tab\\tline\\nname.txt");
    expect(both).toMatchObject({ staged: { kind: "modified" }, unstaged: { kind: "modified" } });
    expect(parsed.response.groups.staged).toEqual([both.path.id]);
    expect(parsed.response.groups.unstaged).toEqual([both.path.id, Buffer.from("deleted.txt").toString("base64url")]);
    const arbitrary = parsed.response.files[1]!;
    expect(arbitrary.path.id).toBe(invalid.toString("base64url"));
    expect(arbitrary.path.utf8Path).toBeUndefined();
    expect(arbitrary.path.display).toBe("bad\\xff");
    expect(parsed.response.files[2]?.unstaged).toEqual({ kind: "deleted" });
  });

  it("parses rename sources, conflict codes, submodules, unborn and detached heads", () => {
    const rename = Buffer.from(`2 R. N... 100644 100644 100644 ${hash} ${hash} R100 new name`);
    const copy = Buffer.from(`2 C. N... 100644 100644 100644 ${hash} ${hash} C075 copied name`);
    const conflict = Buffer.from(`u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} conflict`);
    const parsed = parsePorcelainV2(statusBuffer(
      ...headers("feature", "(initial)"), rename, Buffer.from("old name"), copy, Buffer.from("source name"), conflict,
      ordinary(".M", "SCMU", Buffer.from("module")),
    ));
    expect(parsed.response.head).toEqual({ kind: "unborn", name: "feature" });
    expect(parsed.response.files[0]?.staged).toMatchObject({
      kind: "renamed", originalPath: { utf8Path: "old name" },
    });
    expect(parsed.response.files[1]?.staged).toMatchObject({
      kind: "copied", originalPath: { utf8Path: "source name" },
    });
    expect(parsed.response.files[2]?.conflict).toEqual({ code: "UU" });
    expect(parsed.response.groups.conflicted).toEqual([Buffer.from("conflict").toString("base64url")]);
    expect(parsed.response.files[3]?.submodule).toEqual({ commitChanged: true, trackedModified: true, untracked: true });
    expect(parsePorcelainV2(statusBuffer(...headers("(detached)"))).response.head)
      .toEqual({ kind: "detached", oid: hash });
  });

  it("rejects malformed, duplicate and truncated status wholesale", () => {
    expect(() => parsePorcelainV2(Buffer.from("# branch.oid x\0"))).toThrow(/branch identity/);
    expect(() => parsePorcelainV2(statusBuffer(...headers(), ordinary(".M", "N...", Buffer.from("a")), ordinary(".M", "N...", Buffer.from("a")))))
      .toThrow(/duplicate path/);
    expect(() => parsePorcelainV2(Buffer.concat([statusBuffer(...headers()), Buffer.from("? partial")]))).toThrow(/incomplete/);
  });

  it("validates branch tracking headers, controls, bounds, and duplicates", () => {
    const upstream = Buffer.from("# branch.upstream origin/main");
    const aheadBehind = Buffer.from("# branch.ab +12 -3");
    const unknownAheadBehind = Buffer.from("# branch.ab +? -?");
    expect(() => parsePorcelainV2(statusBuffer(...headers(), upstream, aheadBehind))).not.toThrow();
    expect(() => parsePorcelainV2(statusBuffer(...headers(), upstream, unknownAheadBehind))).not.toThrow();

    const malformed = [
      Buffer.from("# branch.upstream "),
      Buffer.from("# branch.upstream origin//main"),
      Buffer.from("# branch.upstream bad ref"),
      Buffer.from("# branch.upstream bad\x1fref"),
      Buffer.from(`# branch.upstream ${"a".repeat(4_097)}`),
      Buffer.from("# branch.ab +? -1"),
      Buffer.from("# branch.ab +1 -?"),
      Buffer.from("# branch.ab -1 +2"),
      Buffer.from("# branch.ab +1 +2"),
      Buffer.from("# branch.ab +1 -2 trailing"),
      Buffer.from([0x23, 0x20, 0x62, 0x72, 0x61, 0x6e, 0x63, 0x68, 0x2e, 0x61, 0x62, 0x20, 0x2b, 0xb1, 0x20, 0x2d, 0x30]),
      Buffer.from("# branch.ab +9007199254740992 -0"),
      Buffer.concat([Buffer.from("# branch.ab +"), Buffer.alloc(65, 0x31), Buffer.from(" -0")]),
    ];
    for (const record of malformed) {
      expect(() => parsePorcelainV2(statusBuffer(...headers(), record))).toThrow(/branch/);
    }
    expect(() => parsePorcelainV2(statusBuffer(...headers(), upstream, upstream, aheadBehind))).toThrow(/duplicate/);
    expect(() => parsePorcelainV2(statusBuffer(...headers(), upstream, aheadBehind, aheadBehind))).toThrow(/duplicate/);
    expect(() => parsePorcelainV2(statusBuffer(...headers(), upstream))).toThrow(/tracking/);
    expect(() => parsePorcelainV2(statusBuffer(...headers(), aheadBehind))).toThrow(/tracking/);
    expect(() => parsePorcelainV2(statusBuffer(
      Buffer.from(`# branch.oid ${hash}`), Buffer.from("# branch.head bad\nhead"),
    ))).toThrow(/branch/);
    expect(() => parsePorcelainV2(statusBuffer(
      Buffer.from(`# branch.oid ${hash}`), Buffer.from(`# branch.head ${"a".repeat(4_097)}`),
    ))).toThrow(/branch/);
    expect(() => parsePorcelainV2(statusBuffer(...headers(), Buffer.from(`# branch.oid ${hash}`)))).toThrow(/duplicate/);
    expect(() => parsePorcelainV2(statusBuffer(...headers(), Buffer.from("# branch.head other")))).toThrow(/duplicate/);
    expect(() => parsePorcelainV2(statusBuffer(
      Buffer.concat([Buffer.from("# branch.oid "), Buffer.alloc(40, 0xe1)]), Buffer.from("# branch.head main"),
    ))).toThrow(/branch/);
  });

  it("rejects no-facet ordinary records, invalid conflicts, U facets, and malformed rename/copy grammar", () => {
    expect(() => parsePorcelainV2(statusBuffer(...headers(), ordinary("..", "N...", Buffer.from("unchanged")))))
      .toThrow(/facets/);
    const noFacetType2 = statusBuffer(
      ...headers(), Buffer.from(`2 .. N... 100644 100644 100644 ${hash} ${hash} R100 destination`), Buffer.from("source"),
    );
    expect(() => parsePorcelainV2(noFacetType2)).toThrow(/facets/);
    const conflict = (xy: string) => Buffer.from(`u ${xy} N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} conflict`);
    expect(() => parsePorcelainV2(statusBuffer(...headers(), conflict("AD")))).toThrow(/conflict/);
    for (const code of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
      expect(() => parsePorcelainV2(statusBuffer(...headers(), conflict(code)))).not.toThrow();
    }

    expect(() => parsePorcelainV2(statusBuffer(...headers(), ordinary(".U", "N...", Buffer.from("bad")))))
      .toThrow(/facets/);
    const type2 = (xy: string, score: string) => statusBuffer(
      ...headers(),
      Buffer.from(`2 ${xy} N... 100644 100644 100644 ${hash} ${hash} ${score} destination`),
      Buffer.from("source"),
    );
    expect(() => parsePorcelainV2(type2("M.", "R100"))).toThrow(/rename/);
    expect(() => parsePorcelainV2(type2("R.", "C100"))).toThrow(/rename/);
    expect(() => parsePorcelainV2(type2("R.", "R101"))).toThrow(/rename/);
    expect(() => parsePorcelainV2(type2("RC", "R050"))).toThrow(/rename/);
  });

  it("projects at most the explicit status cardinality while declaring the total", () => {
    const records = Array.from({ length: 1_005 }, (_, index) =>
      Buffer.from(`? file-${String(index).padStart(4, "0")}`));
    const parsed = parsePorcelainV2(statusBuffer(...headers(), ...records));
    expect(parsed.response).toMatchObject({ total: 1_005, truncated: true });
    expect(parsed.response.files).toHaveLength(1_000);
    expect(parsed.response.groups.untracked).toHaveLength(1_000);
    expect(new Set(parsed.response.groups.untracked).size).toBe(1_000);
  });
});

describe("bounded diff contract", () => {
  it("applies status cardinality projection through the service contract", async () => {
    const records = Array.from({ length: 1_005 }, (_, index) =>
      Buffer.from(`? service-file-${String(index).padStart(4, "0")}`));
    const fake = runnerForStatus(statusBuffer(...headers(), ...records));
    const result = await new GitInspectionService(fake.runner).status("/workspace");
    expect(result).toMatchObject({ kind: "repository", total: 1_005, truncated: true });
    if (result.kind === "repository") {
      expect(result.files).toHaveLength(1_000);
      expect(result.groups.untracked).toHaveLength(1_000);
    }
  });

  it("numbers unified text, including omitted and zero hunk counts", () => {
    const parsed = parseUnifiedDiff(Buffer.from([
      "diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -2 +2,2 @@", " old", "-gone", "+new", "+more", "\\ No newline at end of file", "@@ -0,0 +1 @@", "+first", "",
    ].join("\n")));
    expect(parsed.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["meta", null, null], ["meta", null, null], ["meta", null, null], ["hunk", null, null],
      ["context", 2, 2], ["delete", 3, null], ["add", null, 3], ["add", null, 4],
      ["meta", null, null], ["hunk", null, null], ["add", null, 1],
    ]);
    const truncated = parseUnifiedDiff(Buffer.from("@@ -1 +1 @@\n-old\n+incomplete"), true);
    expect(truncated.lines.at(-1)).toMatchObject({ kind: "meta", text: expect.stringContaining("truncated") });
    expect(truncated.lines.some((line) => line.text === "+incomplete")).toBe(false);
  });

  it("caps the projected diff line cardinality through the service contract", async () => {
    const path = Buffer.from("many.txt");
    const patch = Buffer.from([
      "--- a/many.txt", "+++ b/many.txt", "@@ -1,2100 +1,2100 @@",
      ...Array.from({ length: 2_100 }, (_, index) => ` line-${index}`),
      "",
    ].join("\n"));
    const fake = runnerForStatus(statusBuffer(...headers(), ordinary(".M", "N...", path)), (args) =>
      args.includes("--numstat") ? { stdout: Buffer.from("2100\t2100\tmany.txt\0") } : { stdout: patch });
    const result = await new GitInspectionService(fake.runner).diff("/workspace", path.toString("base64url"), "unstaged");
    expect(result).toMatchObject({ kind: "text", truncated: true });
    if (result.kind === "text") {
      expect(result.lines).toHaveLength(2_000);
      expect(result.lines.at(-1)).toMatchObject({ kind: "meta", text: expect.stringContaining("projected lines") });
    }
  });

  it("authorizes a fresh facet and uses only the closed safe diff argv", async () => {
    const path = Buffer.from("file.txt");
    const fixture = statusBuffer(...headers(), ordinary("MM", "N...", path));
    const fake = runnerForStatus(fixture, (args) => args.includes("--numstat")
      ? { stdout: Buffer.from("1\t1\tfile.txt\0") }
      : { stdout: Buffer.from("--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n") });
    const result = await new GitInspectionService(fake.runner).diff("/workspace", path.toString("base64url"), "staged");
    expect(result).toMatchObject({ kind: "text", side: "staged", truncated: false });
    const diffCalls = fake.calls.filter((args) => args.includes("diff"));
    expect(diffCalls).toHaveLength(2);
    for (const args of fake.calls) {
      expect(args).toEqual(expect.arrayContaining(["-c", "core.fsmonitor=false"]));
    }
    const statusCall = fake.calls.find((args) => args.includes("status"));
    expect(statusCall).toBeDefined();
    expect(statusCall).toContain("--no-ahead-behind");
    for (const args of diffCalls) {
      expect(args).toContain("--no-ext-diff");
      expect(args).toContain("--no-textconv");
      expect(args.at(-2)).toBe("--");
      expect(args.at(-1)).toBe("file.txt");
      expect(args).not.toEqual(expect.arrayContaining(["add", "commit", "restore", "checkout", "reset", "push", "fetch", "blame", "log"]));
    }
    expect(diffCalls.every((args) => args.includes("--cached"))).toBe(true);
  });

  it("returns explicit binary, conflict, submodule, empty, unsupported and truncated states", async () => {
    const binaryPath = Buffer.from("binary.dat");
    const binaryFixture = statusBuffer(...headers(), ordinary(".M", "N...", binaryPath));
    const binary = runnerForStatus(binaryFixture, (args) => args.includes("--numstat") ? { stdout: Buffer.from("-\t-\tbinary.dat\0") } : undefined);
    expect(await new GitInspectionService(binary.runner).diff("/w", binaryPath.toString("base64url"), "unstaged")).toMatchObject({ kind: "binary" });

    const conflictPath = Buffer.from("conflict");
    const conflictRecord = Buffer.from(`u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} conflict`);
    const conflict = runnerForStatus(statusBuffer(...headers(), conflictRecord));
    expect(await new GitInspectionService(conflict.runner).diff("/w", conflictPath.toString("base64url"), "unstaged")).toMatchObject({ kind: "conflict", code: "UU" });

    const modulePath = Buffer.from("module");
    const module = runnerForStatus(statusBuffer(...headers(), ordinary(".M", "SC..", modulePath)));
    expect(await new GitInspectionService(module.runner).diff("/w", modulePath.toString("base64url"), "unstaged")).toMatchObject({ kind: "submodule" });

    const invalid = Buffer.from([0xff]);
    const unsupported = runnerForStatus(statusBuffer(...headers(), ordinary(".M", "N...", invalid)));
    expect(await new GitInspectionService(unsupported.runner).diff("/w", invalid.toString("base64url"), "unstaged")).toMatchObject({ kind: "unsupported", reason: "path-encoding" });

    const textPath = Buffer.from("empty.txt");
    const empty = runnerForStatus(statusBuffer(...headers(), ordinary(".M", "N...", textPath)), () => ({ stdout: Buffer.alloc(0) }));
    expect(await new GitInspectionService(empty.runner).diff("/w", textPath.toString("base64url"), "unstaged")).toMatchObject({ kind: "empty" });

    const truncated = runnerForStatus(statusBuffer(...headers(), ordinary(".M", "N...", textPath)), (args) => args.includes("--numstat")
      ? { stdout: Buffer.from("1\t1\tempty.txt\0") }
      : { stdout: Buffer.from("@@ -1 +1 @@\n-old\n+partial"), truncated: true });
    const truncatedResult = await new GitInspectionService(truncated.runner).diff("/w", textPath.toString("base64url"), "unstaged");
    expect(truncatedResult).toMatchObject({ kind: "text", truncated: true });
    if (truncatedResult.kind === "text") expect(truncatedResult.lines.at(-1)?.text).toContain("truncated");
  });

  it("sanitizes environment and kills hostile descendant groups on cap, timeout, and abort", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-fake-git-"));
    const marker = join(directory, "descendant-alive");
    const previous = {
      PATH: process.env.PATH,
      GIT_DIR: process.env.GIT_DIR,
      GIT_ASKPASS: process.env.GIT_ASKPASS,
      GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF,
      SSH_ASKPASS: process.env.SSH_ASKPASS,
      LD_PRELOAD: process.env.LD_PRELOAD,
      DESCENDANT_MARKER: process.env.DESCENDANT_MARKER,
    };
    try {
      const childCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), Number(process.argv[1]))`;
      await writeFile(join(directory, "git"), `#!${process.execPath}\nconst { spawn } = require("node:child_process");\nconst mode = process.argv[2];\nconst childCode = ${JSON.stringify(childCode)};\nconst descendant = (delay) => spawn(process.execPath, ["-e", childCode, String(delay)], { stdio: "ignore" });\nif (mode === "env") process.stdout.write(JSON.stringify({ GIT_DIR: process.env.GIT_DIR, GIT_ASKPASS: process.env.GIT_ASKPASS, GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF, SSH_ASKPASS: process.env.SSH_ASKPASS, LD_PRELOAD: process.env.LD_PRELOAD }));\nelse if (mode === "slow") { descendant(4500); setTimeout(() => {}, 10_000); }\nelse if (mode === "cap") { descendant(500); process.stdout.write(Buffer.alloc(64, 120)); setTimeout(() => {}, 10_000); }\nelse if (mode === "abort") { descendant(500); setTimeout(() => {}, 10_000); }\nelse if (mode === "stderr") process.stderr.write(Buffer.alloc(${GIT_STDERR_BYTES + 1}, 120));\nelse process.stdout.write(Buffer.alloc(64, 120));\n`, { mode: 0o755 });
      process.env.PATH = directory;
      process.env.GIT_DIR = "/attacker/repository";
      process.env.GIT_ASKPASS = "/attacker/askpass";
      process.env.GIT_EXTERNAL_DIFF = "/attacker/diff";
      process.env.SSH_ASKPASS = "/attacker/ssh-askpass";
      process.env.LD_PRELOAD = "/attacker/preload";
      process.env.DESCENDANT_MARKER = marker;

      const sanitized = await spawnGit(["env"], { stdoutLimit: 1_024 });
      expect(JSON.parse(sanitized.stdout.toString("utf8"))).toEqual({});
      await expect(spawnGit(["big"], { stdoutLimit: 32 })).rejects.toThrow(/output exceeded/);
      await expect(spawnGit(["stderr"], { stdoutLimit: 32 })).rejects.toThrow(/output exceeded/);

      await expect(spawnGit(["cap"], { stdoutLimit: 32 })).rejects.toThrow(/output exceeded/);
      await delay(700);
      await expect(access(marker)).rejects.toThrow();

      const controller = new AbortController();
      const aborted = spawnGit(["abort"], { stdoutLimit: 32, signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      await expect(aborted).rejects.toMatchObject({ status: 499, message: "Git inspection was cancelled" });
      await delay(700);
      await expect(access(marker)).rejects.toThrow();

      await expect(spawnGit(["slow"], { stdoutLimit: 32 })).rejects.toMatchObject({ status: 503, message: "Git inspection timed out" });
      await delay(700);
      await expect(access(marker)).rejects.toThrow();

      const partial = await spawnGit(["big"], { stdoutLimit: 32, allowStdoutTruncation: true });
      expect(partial).toMatchObject({ truncated: true });
      expect(partial.stdout).toHaveLength(32);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, GIT_TIMEOUT_MS + 8_000);

  it("rejects forged IDs before any diff command and preserves operational failures", async () => {
    const path = Buffer.from("safe.txt");
    const fixture = statusBuffer(...headers(), ordinary(".M", "N...", path));
    const fake = runnerForStatus(fixture);
    await expect(new GitInspectionService(fake.runner).diff("/w", Buffer.from("other").toString("base64url"), "unstaged"))
      .rejects.toMatchObject({ status: 409 });
    expect(fake.calls.some((args) => args.includes("diff"))).toBe(false);

    const failure: GitRunner = async () => { throw new GitInspectionError("Git inspection timed out", 503); };
    await expect(new GitInspectionService(failure).status("/w")).rejects.toMatchObject({ status: 503 });
    const nonrepo: GitRunner = async () => { throw new GitInspectionError("Git inspection failed", 502, "not a repo", 128); };
    await expect(new GitInspectionService(nonrepo).status(tmpdir())).resolves.toEqual({ kind: "not-repository" });
    expect({ GIT_TIMEOUT_MS, GIT_STATUS_OUTPUT_BYTES, GIT_DIFF_OUTPUT_BYTES, GIT_STDERR_BYTES }).toEqual({
      GIT_TIMEOUT_MS: 4_000, GIT_STATUS_OUTPUT_BYTES: 4 * 1024 * 1024,
      GIT_DIFF_OUTPUT_BYTES: 1024 * 1024, GIT_STDERR_BYTES: 64 * 1024,
    });
  });
});

describe("real temporary repository", () => {
  const directories: string[] = [];
  afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

  it("accepts Git's paired unknown ahead/behind tracking header through the real service", async () => {
    const origin = await mkdtemp(join(tmpdir(), "inspire-tracking-origin-"));
    const root = await mkdtemp(join(tmpdir(), "inspire-tracking-work-"));
    directories.push(origin, root);
    await exec("git", ["init", "-q", "--bare", origin]);
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "tracked.txt"), "base\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    await exec("git", ["-C", root, "remote", "add", "origin", origin]);
    await exec("git", ["-C", root, "push", "-qu", "origin", "HEAD"]);
    await writeFile(join(root, "tracked.txt"), "local-commit\n");
    await exec("git", ["-C", root, "commit", "-qam", "ahead"]);
    await writeFile(join(root, "tracked.txt"), "working-change\n");

    const raw = await exec("git", ["-C", root, "status", "--porcelain=v2", "--branch", "-z", "--no-ahead-behind"]);
    expect(raw.stdout).toContain("# branch.ab +? -?\0");
    const status = await new GitInspectionService().status(root);
    expect(status).toMatchObject({ kind: "repository", head: { kind: "branch" } });
    if (status.kind === "repository") {
      expect(status.files.find((file) => file.path.utf8Path === "tracked.txt")?.unstaged?.kind).toBe("modified");
    }
  });

  it("handles unborn, nested cwd, staged+unstaged, untracked and binary", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspire-git-"));
    directories.push(root);
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    const service = new GitInspectionService();
    expect(await service.status(root)).toMatchObject({ kind: "repository", head: { kind: "unborn" } });

    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "both.txt"), "base\n");
    await writeFile(join(root, ":(glob)*.txt"), "magic-base\n");
    await writeFile(join(root, "other.txt"), "other-base\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "initial"]);
    await exec("git", ["-C", root, "checkout", "-q", "--detach"]);
    expect(await service.status(root)).toMatchObject({ kind: "repository", head: { kind: "detached" } });
    await writeFile(join(root, "nested", "both.txt"), "staged\n");
    await exec("git", ["-C", root, "add", "nested/both.txt"]);
    await writeFile(join(root, "nested", "both.txt"), "unstaged\n");
    await writeFile(join(root, ":(glob)*.txt"), "magic-new\n");
    await exec("git", ["-C", root, "mv", "other.txt", "renamed.txt"]);
    await writeFile(join(root, "renamed.txt"), "renamed-new\n");
    await writeFile(join(root, "nested", "new file.txt"), "new\n");
    await writeFile(join(root, "nested", "binary.dat"), Buffer.from([0, 1, 2]));
    await symlink("both.txt", join(root, "nested", "link.txt"));
    const newlineCwd = join(root, "line\nbreak");
    await mkdir(newlineCwd);
    await writeFile(join(newlineCwd, "inside.txt"), "inside\n");

    const monitorDirectory = await mkdtemp(join(tmpdir(), "inspire-fsmonitor-"));
    directories.push(monitorDirectory);
    const monitorMarker = join(monitorDirectory, "executed");
    const monitor = join(monitorDirectory, "monitor");
    await writeFile(monitor, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(monitorMarker)}, "executed");\nprocess.stdout.write("0\\n");\n`, { mode: 0o755 });
    await exec("git", ["-C", root, "config", "core.fsmonitor", monitor]);

    const status = await service.status(join(root, "nested"));
    await expect(access(monitorMarker)).rejects.toThrow();
    expect(status.kind).toBe("repository");
    if (status.kind !== "repository") return;
    const newlineStatus = await service.status(newlineCwd);
    expect(newlineStatus.kind).toBe("repository");
    if (newlineStatus.kind === "repository") {
      expect(newlineStatus.files.find((file) => file.path.utf8Path === "line\nbreak/inside.txt")?.path.workspacePath).toBe("inside.txt");
    }
    await expect(access(monitorMarker)).rejects.toThrow();
    const both = status.files.find((file) => file.path.utf8Path === "nested/both.txt")!;
    expect(both.path.workspacePath).toBe("both.txt");
    expect(both).toMatchObject({ staged: { kind: "modified" }, unstaged: { kind: "modified" } });
    expect((await service.diff(join(root, "nested"), both.path.id, "staged")).kind).toBe("text");
    expect((await service.diff(join(root, "nested"), both.path.id, "unstaged")).kind).toBe("text");
    const magic = status.files.find((file) => file.path.utf8Path === ":(glob)*.txt")!;
    expect(magic.path.workspacePath).toBeUndefined();
    const magicDiff = await service.diff(join(root, "nested"), magic.path.id, "unstaged");
    expect(magicDiff.kind).toBe("text");
    if (magicDiff.kind === "text") expect(magicDiff.lines.map((line) => line.text).join("\n")).not.toContain("renamed.txt");
    const renamed = status.files.find((file) => file.path.utf8Path === "renamed.txt")!;
    expect(renamed.staged).toMatchObject({ kind: "renamed", originalPath: { utf8Path: "other.txt" } });
    expect((await service.diff(join(root, "nested"), renamed.path.id, "staged")).kind).toBe("text");
    for (const workspacePath of ["new file.txt", "binary.dat", "link.txt"]) {
      const untracked = status.files.find((file) => file.path.workspacePath === workspacePath)!;
      expect(await service.diff(join(root, "nested"), untracked.path.id, "unstaged"))
        .toMatchObject({ kind: "unsupported", reason: "untracked-content" });
    }
  });

  it("never opens untracked content through symlinks, directory swaps, FIFOs, or device targets", async () => {
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
    const byPath = (path: string) => initial.files.find((file) => file.path.utf8Path === path)!;
    const bounded = <T>(operation: Promise<T>) => Promise.race([
      operation,
      delay(750).then(() => { throw new Error("untracked inspection hung"); }),
    ]);
    for (const path of ["final-link", "intermediate-link", "device-link"]) {
      const change = byPath(path);
      expect(change, path).toBeDefined();
      await expect(bounded(service.diff(root, change.path.id, "unstaged")))
        .resolves.toMatchObject({ kind: "unsupported", reason: "untracked-content" });
    }

    await expect(bounded(service.diff(root, Buffer.from("named-pipe").toString("base64url"), "unstaged")))
      .rejects.toMatchObject({ status: 409 });

    const victim = byPath("swap/victim");
    expect(victim).toBeDefined();
    await renamePath(join(root, "swap"), join(root, "swap-original"));
    await symlink(outside, join(root, "swap"));
    await expect(bounded(service.diff(root, victim.path.id, "unstaged"))).rejects.toMatchObject({ status: 409 });
  });

  it("parses a real merge conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "inspire-conflict-"));
    directories.push(root);
    await exec("git", ["init", "-q", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "conflict.txt"), "base\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-qm", "base"]);
    const { stdout } = await exec("git", ["-C", root, "branch", "--show-current"]);
    const mainBranch = stdout.trim();
    await exec("git", ["-C", root, "checkout", "-qb", "other"]);
    await writeFile(join(root, "conflict.txt"), "other\n");
    await exec("git", ["-C", root, "commit", "-qam", "other"]);
    await exec("git", ["-C", root, "checkout", "-q", mainBranch]);
    await writeFile(join(root, "conflict.txt"), "main\n");
    await exec("git", ["-C", root, "commit", "-qam", "main"]);
    await expect(exec("git", ["-C", root, "merge", "other"])).rejects.toBeDefined();

    const service = new GitInspectionService();
    const status = await service.status(root);
    expect(status.kind).toBe("repository");
    if (status.kind !== "repository") return;
    const conflict = status.files.find((file) => file.path.utf8Path === "conflict.txt")!;
    expect(conflict.conflict).toEqual({ code: "UU" });
    await expect(service.diff(root, conflict.path.id, "unstaged")).resolves.toMatchObject({ kind: "conflict", code: "UU" });
  });

  it("parses a real local submodule without invoking content helpers", async () => {
    const source = await mkdtemp(join(tmpdir(), "inspire-submodule-source-"));
    const root = await mkdtemp(join(tmpdir(), "inspire-submodule-parent-"));
    directories.push(source, root);
    for (const repository of [source, root]) {
      await exec("git", ["init", "-q", repository]);
      await exec("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
      await exec("git", ["-C", repository, "config", "user.name", "Test"]);
    }
    await writeFile(join(source, "tracked.txt"), "base\n");
    await exec("git", ["-C", source, "add", "."]);
    await exec("git", ["-C", source, "commit", "-qm", "base"]);
    await exec("git", ["-c", "protocol.file.allow=always", "-C", root, "submodule", "add", "-q", source, "modules/local"]);
    await exec("git", ["-C", root, "commit", "-qam", "submodule"]);
    await writeFile(join(root, "modules", "local", "tracked.txt"), "modified\n");
    const monitorDirectory = await mkdtemp(join(tmpdir(), "inspire-submodule-monitor-"));
    directories.push(monitorDirectory);
    const monitorMarker = join(monitorDirectory, "executed");
    const monitor = join(monitorDirectory, "monitor");
    await writeFile(monitor, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(monitorMarker)}, "executed");\nprocess.stdout.write("0\\n");\n`, { mode: 0o755 });
    await exec("git", ["-C", join(root, "modules", "local"), "config", "core.fsmonitor", monitor]);

    const service = new GitInspectionService();
    const status = await service.status(root);
    await expect(access(monitorMarker)).rejects.toThrow();
    expect(status.kind).toBe("repository");
    if (status.kind !== "repository") return;
    const module = status.files.find((file) => file.path.utf8Path === "modules/local")!;
    expect(module.submodule).toMatchObject({ trackedModified: true });
    await expect(service.diff(root, module.path.id, "unstaged")).resolves.toMatchObject({ kind: "submodule" });
  });
});
