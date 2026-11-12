// @vitest-environment jsdom
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitInspectionService } from "../../server/git-inspection";
import { sourceDiffRows } from "../../src/source-diff";

const exec = promisify(execFile);
describe("native Git diff and source projection", () => {
  it.each([0, 600])(
    "keeps a change at line 2200 reachable with %i-byte prefix rows",
    async (width) => {
      const root = await mkdtemp(join(tmpdir(), "inspire-git-prefix-"));
      const git = (...args: string[]) => exec("git", ["-C", root, ...args]);
      try {
        await git("init", "-q");
        const source = Array.from(
          { length: 2500 },
          (_, i) => "x".repeat(width) + " line " + (i + 1),
        );
        source[0] = "/*";
        source[2499] = "*/";
        await writeFile(join(root, "source.ts"), source.join("\n") + "\n");
        await git("add", ".");
        await git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-qm",
          "base",
        );
        source[2199] = "const changed = 42;";
        await writeFile(join(root, "source.ts"), source.join("\n") + "\n");
        const diff = await new GitInspectionService().diff(
          root,
          Buffer.from("source.ts").toString("base64url"),
        );
        if (diff.kind !== "text")
          throw new Error(`Expected text diff, got ${diff.kind}`);
        expect(diff.lines.find((line) => line.kind === "add")).toMatchObject({
          newLine: 2200,
          text: "+const changed = 42;",
        });
        expect(diff).toMatchObject({
          additions: 1,
          deletions: 1,
          truncated: false,
          contextLimited: true,
        });
        expect(diff.lines.length).toBeLessThan(30);
        const { rows, changes } = sourceDiffRows(diff);
        expect(changes).toBe(1);
        const changed = rows.find((row) => row.line.kind === "add")!;
        expect(changed).toMatchObject({
          changeIndex: 0,
          line: { newLine: 2200 },
        });
        const code = document.createElement("code");
        code.innerHTML = changed.html;
        expect(code.textContent).toBe("const changed = 42;");
        if (width === 0) {
          // The opening comment is thousands of lines outside the displayed hunk.
          expect(code.querySelector(".hljs-comment")?.textContent).toBe(
            "const changed = 42;",
          );
        } else {
          expect(changed.html).toBe("const changed = 42;");
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
