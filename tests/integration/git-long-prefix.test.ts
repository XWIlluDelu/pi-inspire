// @vitest-environment jsdom
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { GitInspectionService } from "../../server/git-inspection";
import type { GitDiffResponse } from "../../shared/contracts";
import { sourceDiffRows } from "../../src/source-diff";
import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "../server/fixtures/host-api";

const exec = promisify(execFile);
describe("bounded Git diff through the Host and source projection", () => {
  it.each([
    [0, "unstaged"],
    [600, "unstaged"],
    [0, "staged"],
  ] as const)(
    "keeps a change at line 2200 reachable with %i-byte prefix rows (%s)",
    async (width, side) => {
      const root = await mkdtemp(join(tmpdir(), "inspire-git-prefix-"));
      const f = await hostApiFixture();
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
        if (side === "staged") await git("add", ".");
        const service = new GitInspectionService();
        f.git.status = (_cwd, signal) => service.status(root, signal);
        f.git.diff = (_cwd, id, selectedSide, signal) =>
          service.diff(root, id, selectedSide, signal);
        await request(f.application.server)
          .post("/api/sessions/open")
          .set("Authorization", `Bearer ${token}`)
          .send({ id: "mock-active" })
          .expect(200);
        const response = await request(f.application.server)
          .post("/api/git/diff")
          .set("Authorization", `Bearer ${token}`)
          .send({
            sessionId: "mock-active",
            pathId: Buffer.from("source.ts").toString("base64url"),
            side,
          })
          .expect(200);
        const diff = response.body as Extract<
          GitDiffResponse,
          { kind: "text" }
        >;
        expect(diff.lines.find((line) => line.kind === "add")).toMatchObject({
          newLine: 2200,
          text: "+const changed = 42;",
        });
        expect(diff).toMatchObject({
          kind: "text",
          additions: 1,
          deletions: 1,
          truncated: false,
          contextLimited: true,
        });
        expect(diff.lines.length).toBeLessThan(30);
        const projection = sourceDiffRows(diff);
        expect(projection.changes).toBe(1);
        expect(projection.rows.filter((row) => row.startsChange)).toHaveLength(
          1,
        );
        const changed = projection.rows.find((row) => row.line.kind === "add")!;
        expect(changed.changeIndex).toBe(0);
        const code = document.createElement("code");
        code.innerHTML = changed.html;
        expect(code.textContent).toBe("const changed = 42;");
        if (width === 0) {
          expect(diff.source).toBeDefined();
          // The opening comment is thousands of lines outside the displayed hunk.
          expect(code.querySelector(".hljs-comment")).not.toBeNull();
          expect(code.querySelector(".hljs-keyword")).toBeNull();
        } else {
          expect(diff.source).toBeUndefined();
          expect(code.querySelector("span")).toBeNull();
        }
      } finally {
        await closeHostApiFixture(f);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
