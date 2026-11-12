import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionCatalog } from "../../server/session-catalog.js";
import { SessionMetadataIndex } from "../../server/session-metadata.js";
import { ATTACHMENT_CONTEXT_HEADING } from "../../shared/attachment-context.js";
import type { SessionCatalogIssue } from "../../shared/contracts.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "inspire-session-metadata-"));
  directories.push(path);
  return path;
}

function header(id = "session-a") {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/work/project",
  };
}

function message(
  id: string,
  role: "user" | "assistant" | "toolResult",
  content: string,
  timestamp: number,
) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: { role, content, timestamp },
  };
}

function jsonl(...entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("SessionMetadataIndex", () => {
  it("deduplicates root aliases without admitting symlinked sessions", async () => {
    const root = await directory();
    const alias = `${root}-alias`;
    directories.push(alias);
    await writeFile(join(root, "session.jsonl"), jsonl(header()));
    const outside = join(await directory(), "outside.jsonl");
    await writeFile(outside, jsonl(header("outside")));
    await symlink(outside, join(root, "linked.jsonl"));
    await symlink(
      root,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const index = new SessionMetadataIndex();
    expect((await index.list([root, root, alias])).map(({ id }) => id)).toEqual(
      ["session-a"],
    );
  });

  it("publishes partial catalog pages but requires a complete scan to establish absence", async () => {
    const root = await directory();
    const healthy = join(root, "healthy");
    const offline = join(root, "offline");
    await mkdir(healthy);
    await mkdir(offline);
    await writeFile(join(healthy, "one.jsonl"), jsonl(header("one")));
    await writeFile(join(offline, "two.jsonl"), jsonl(header("two")));
    const index = new SessionMetadataIndex();
    const roots = [healthy, offline, join(root, "missing")];
    const catalog = new SessionCatalog(root, {
      list: (_directories, issues) => index.list(roots, issues),
    });
    const rows = [{ id: "one" }, { id: "two" }];
    expect(await catalog.list()).toMatchObject({ sessions: rows, total: 2 });
    await rename(offline, `${offline}-saved`);
    await writeFile(offline, "not a directory");

    await expect(index.list(roots)).rejects.toMatchObject({ code: "ENOTDIR" });
    const incomplete = { code: "SESSION_CATALOG_INCOMPLETE" };
    await expect(
      catalog.refresh(true, { requireComplete: true }),
    ).rejects.toMatchObject(incomplete);
    expect(await catalog.list()).toMatchObject({
      sessions: rows,
      total: 2,
      issues: [{ path: offline }],
    });
    expect(await catalog.get("one")).toMatchObject({
      path: join(healthy, "one.jsonl"),
    });
    await expect(catalog.get("unknown")).rejects.toMatchObject(incomplete);
    expect(await catalog.listByCwds([header().cwd])).toMatchObject(rows);

    const coldIssues: SessionCatalogIssue[] = [];
    expect(
      await new SessionMetadataIndex().list(roots, coldIssues),
    ).toMatchObject([{ id: "one" }]);
    expect(coldIssues).toMatchObject([{ path: offline }]);

    await rm(offline);
    await rename(`${offline}-saved`, offline);
    await catalog.refresh(true, { requireComplete: true });
    expect(await catalog.list()).not.toHaveProperty("issues");
    expect(await catalog.get("unknown")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports unreadable session files to strict and partial catalog readers",
    async () => {
      const root = await directory();
      const path = join(root, "unreadable.jsonl");
      await writeFile(path, jsonl(header()));
      await chmod(path, 0o000);
      try {
        const index = new SessionMetadataIndex();
        await expect(index.list(root)).rejects.toMatchObject({
          code: "EACCES",
        });
        const issues: SessionCatalogIssue[] = [];
        await expect(index.list(root, issues)).resolves.toEqual([]);
        expect(issues).toEqual([expect.objectContaining({ path })]);
      } finally {
        await chmod(path, 0o600);
      }
    },
  );

  it("projects only bounded catalog metadata from Pi JSONL", async () => {
    const root = await directory();
    const path = join(root, "session.jsonl");
    await writeFile(
      path,
      [
        header(),
        { type: "session_info", id: "n1", name: " Old name " },
        message("t1", "toolResult", "tool output", 1_767_225_601_000),
        message("u1", "user", "first prompt", 1_767_225_602_000),
        message("a1", "assistant", "answer", 1_767_225_603_000),
        { type: "session_info", id: "n2", name: " Current name " },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    const records = await new SessionMetadataIndex().list(root);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "session-a",
      cwd: "/work/project",
      name: "Current name",
      firstMessage: "first prompt",
      messageCount: 3,
    });
    expect(records[0]?.modified.toISOString()).toBe("2026-01-01T00:00:03.000Z");
  });

  it("keeps image notes and file trailers out of titles while retaining searchable file paths", async () => {
    const root = await directory();
    const entry = message("u1", "user", "", 1_767_225_602_000);
    const trailer = `${ATTACHMENT_CONTEXT_HEADING}\n- "/demo/report.csv"`;
    const note =
      "[Image: original 2560x133, displayed at 2000x104. Multiply coordinates by 1.28 to map to original image.]";
    await writeFile(
      join(root, "review.jsonl"),
      jsonl(header("review"), {
        ...entry,
        message: {
          ...entry.message,
          content: [
            { type: "text", text: "Review this report" },
            { type: "image", mimeType: "image/png", data: "cGl4ZWxz" },
            { type: "text", text: `${trailer}\n\n${note}` },
          ],
        },
      }),
    );
    await writeFile(
      join(root, "file-only.jsonl"),
      jsonl(header("file-only"), {
        ...entry,
        message: { ...entry.message, content: trailer },
      }),
    );
    await writeFile(
      join(root, "empty.jsonl"),
      jsonl(header("empty"), {
        ...entry,
        message: { ...entry.message, content: "   " },
      }),
    );
    const index = new SessionMetadataIndex();
    const records = await index.list(root);
    const catalog = new SessionCatalog(root, { list: () => index.list(root) });
    expect((await catalog.list()).sessions).toMatchObject([
      { id: "empty", title: "New session" },
      { id: "file-only", title: "report.csv" },
      { id: "review", title: "Review this report", project: "project" },
    ]);
    expect(
      (await index.scanSearch(records, "report.csv"))
        .map(({ id }) => id)
        .sort(),
    ).toEqual(["file-only", "review"]);
    expect(await index.scanSearch(records, '"Multiply coordinates"')).toEqual(
      [],
    );
  });

  it("counts a partial append once after its final frame arrives", async () => {
    const root = await directory();
    const path = join(root, "session.jsonl");
    const first = message("u1", "user", "first prompt", 1_767_225_601_000);
    const next = JSON.stringify(
      message("a1", "assistant", "split frame", 1_767_225_602_000),
    );
    const split = Math.floor(next.length / 2);
    await writeFile(path, jsonl(header(), first) + next.slice(0, split));
    const index = new SessionMetadataIndex();
    expect((await index.list(root))[0]).toMatchObject({
      messageCount: 1,
      firstMessage: "first prompt",
    });

    await appendFile(path, next.slice(split) + "\n");
    for (const records of [await index.list(root), await index.list(root)])
      expect(records[0]).toMatchObject({
        messageCount: 2,
        firstMessage: "first prompt",
      });
  });

  it("rejects malformed session authority instead of inventing catalog identity", async () => {
    const root = await directory();
    await writeFile(
      join(root, "missing-cwd.jsonl"),
      `${JSON.stringify({ ...header("missing-cwd"), cwd: undefined })}\n`,
    );
    await writeFile(
      join(root, "relative-cwd.jsonl"),
      `${JSON.stringify({ ...header("relative-cwd"), cwd: "project" })}\n`,
    );
    await writeFile(
      join(root, "second-header.jsonl"),
      `${JSON.stringify(header("first"))}\n${JSON.stringify(header("second"))}\n`,
    );

    await expect(new SessionMetadataIndex().list(root)).resolves.toEqual([]);
  });

  it("lists only verified catalog metadata across corruptions and repairs", async () => {
    const root = await directory();
    const path = join(root, "session.jsonl");
    const damaged = jsonl(header()) + "{broken}\n";
    await writeFile(path, damaged);
    const warm = new SessionMetadataIndex();
    expect(await warm.list(root)).toEqual([]);
    await writeFile(
      path,
      jsonl(header(), message("u1", "user", "repaired", 1_767_225_601_000)),
    );
    expect((await warm.list(root))[0]).toMatchObject({
      id: "session-a",
      firstMessage: "repaired",
    });

    await writeFile(path, damaged);
    expect((await warm.list(root))[0]).toMatchObject({
      id: "session-a",
      firstMessage: "repaired",
    });
    expect(await new SessionMetadataIndex().list(root)).toEqual([]);
  });
});
