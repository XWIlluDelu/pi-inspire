import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  GIT_TIMEOUT_MS,
  GitInspectionService,
  type GitRunner,
  parsePorcelainV2,
  parseUnifiedDiff,
  spawnGit,
} from "../../server/git-inspection.js";

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
  const runner: GitRunner = async (args) => {
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
  return new GitInspectionService(runner);
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
    const service = runnerForStatus(
      status,
      undefined,
      Buffer.from("M\0tracked-1004\0"),
    );
    const result = await service.status("/workspace");
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
    const service = runnerForStatus(
      statusBuffer(...headers(), ordinary(".M", "N...", path)),
      (args) =>
        args.includes("--numstat")
          ? { stdout: Buffer.from("2100\t2100\tmany.txt\0") }
          : { stdout: patch },
      Buffer.from("M\0many.txt\0"),
    );
    const result = await service.diff("/workspace", path.toString("base64url"));
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
      await unsupported.diff("/w", invalid.toString("base64url")),
    ).toMatchObject({ kind: "unsupported", reason: "path-encoding" });

    const textPath = Buffer.from("empty.txt");
    const empty = runnerForStatus(
      statusBuffer(...headers(), ordinary(".M", "N...", textPath)),
      () => ({ stdout: Buffer.alloc(0) }),
      Buffer.from("M\0empty.txt\0"),
    );
    expect(
      await empty.diff("/w", textPath.toString("base64url")),
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
    const truncatedResult = await truncated.diff(
      "/w",
      textPath.toString("base64url"),
    );
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
      const keys = [
        "GIT_DIR",
        "GIT_ASKPASS",
        "GIT_EXTERNAL_DIFF",
        "SSH_ASKPASS",
        "LD_PRELOAD",
      ];
      const output = "x".repeat(64);
      try {
        await writeFile(
          join(directory, "git"),
          `#!/bin/sh
case "$1" in
  env) printf '%s' "$GIT_DIR$GIT_ASKPASS$GIT_EXTERNAL_DIFF$SSH_ASKPASS$LD_PRELOAD" ;;
  stderr) printf '${output}' >&2 ;;
  big) printf '${output}' ;;
  *)
    (sleep "$4"; printf alive > "$3") >/dev/null 2>&1 &
    printf '%s' "$!" > "$2"
    [ "$1" != cap ] || printf '${output}'
    wait
    ;;
esac
`,
          { mode: 0o755 },
        );
        vi.stubEnv("PATH", directory + ":/bin:/usr/bin");
        for (const key of keys) vi.stubEnv(key, "must-not-pass");
        const sanitized = await spawnGit(["env"], { stdoutLimit: 1_024 });
        expect(sanitized.stdout.toString("utf8")).toBe("");
        await expect(
          spawnGit(["stderr"], { stdoutLimit: 32, stderrLimit: 32 }),
        ).rejects.toThrow(/output exceeded/);

        for (const [mode, status, message] of [
          ["cap", 502, /output exceeded/],
          ["abort", 499, /cancelled/],
          ["slow", 503, /timed out/],
        ] as const) {
          const started = join(directory, mode + "-started");
          const marker = join(directory, mode + "-alive");
          const controller = new AbortController();
          const result = expect(
            spawnGit([mode, started, marker, "0.7"], {
              stdoutLimit: 32,
              signal: controller.signal,
              timeoutMs: 500,
            }),
          ).rejects.toMatchObject({
            status,
            message: expect.stringMatching(message),
          });
          if (mode === "abort") {
            await expect.poll(() => readFile(started, "utf8")).toMatch(/^\d+$/);
            controller.abort();
          }
          await result;
          expect(await readFile(started, "utf8")).toMatch(/^\d+$/);
          await delay(800);
          await expect(access(marker)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }

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
});
