import { appendFile, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteSessionFile } from "../../server/session-delete.js";
import type { SessionRecord } from "../../server/session-catalog.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(id = "session-a"): Promise<{ dir: string; path: string; session: SessionRecord }> {
  const dir = await mkdtemp(join(tmpdir(), "inspire-delete-"));
  temporary.push(dir);
  const path = join(dir, `${id}.jsonl`);
  await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-01T00:00:00.000Z", cwd: dir })}\n`);
  return {
    dir,
    path,
    session: {
      path,
      id,
      cwd: dir,
      created: new Date("2026-08-01T00:00:00.000Z"),
      modified: new Date("2026-08-01T00:00:00.000Z"),
      messageCount: 0,
      firstMessage: "",
      searchText: dir.toLowerCase(),
    },
  };
}

describe("session file deletion", () => {
  it("moves the validated catalog session to Trash when the command succeeds", async () => {
    const { dir, path, session } = await fixture();
    const trashed = join(dir, "trashed.jsonl");

    await expect(deleteSessionFile(session, async (candidate) => rename(candidate, trashed))).resolves.toBe("trashed");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(trashed, "utf8")).toContain('"id":"session-a"');
  });

  it("falls back to permanent unlink after a failed Trash command", async () => {
    const { path, session } = await fixture();

    await expect(deleteSessionFile(session, async () => { throw new Error("trash unavailable"); })).resolves.toBe("deleted");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a reported Trash failure as success when the file already moved", async () => {
    const { dir, path, session } = await fixture();
    const trashed = join(dir, "trashed.jsonl");

    await expect(deleteSessionFile(session, async (candidate) => {
      await rename(candidate, trashed);
      throw new Error("late command failure");
    })).resolves.toBe("trashed");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a mismatched session header without invoking Trash", async () => {
    const { path, session } = await fixture();
    await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: "other" })}\n`);
    let invoked = false;

    await expect(deleteSessionFile(session, async () => { invoked = true; })).rejects.toMatchObject({
      message: "The session file identity does not match the catalog",
      status: 409,
    });
    expect(invoked).toBe(false);
    expect(await readFile(path, "utf8")).toContain('"id":"other"');
  });

  it("refuses a symbolic-link catalog path", async () => {
    const { dir, path } = await fixture("source");
    const linkedPath = join(dir, "linked.jsonl");
    await symlink(path, linkedPath);
    const session: SessionRecord = {
      path: linkedPath,
      id: "source",
      cwd: dir,
      created: new Date(),
      modified: new Date(),
      messageCount: 0,
      firstMessage: "",
      searchText: "",
    };

    await expect(deleteSessionFile(session, async () => undefined)).rejects.toMatchObject({
      message: "The catalog entry is not a regular session file",
      status: 409,
    });
  });

  it("refuses to unlink the session after a concurrent append on the quarantined inode", async () => {
    const { path, session } = await fixture();
    let quarantine: string | undefined;

    await expect(deleteSessionFile(session, async (candidate) => {
      quarantine = candidate;
      await appendFile(candidate, `${JSON.stringify({ type: "message", id: "late-write" })}\n`);
      throw new Error("trash failed");
    })).rejects.toMatchObject({
      message: "The session file changed before permanent deletion",
      status: 409,
    });
    expect(quarantine).toBeDefined();
    expect(await readFile(quarantine!, "utf8")).toContain("late-write");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a public replacement when Trash moves the original and reports failure", async () => {
    const { dir, path, session } = await fixture();

    await expect(deleteSessionFile(session, async (candidate) => {
      await unlink(candidate);
      await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: session.id, cwd: dir })}\nreplacement\n`);
      throw new Error("trash failed");
    })).resolves.toBe("trashed");
    expect(await readFile(path, "utf8")).toContain("replacement");
  });

  it("rejects a successful Trash command that leaves the quarantine in place", async () => {
    const { path, session } = await fixture();
    let quarantine: string | undefined;

    await expect(deleteSessionFile(session, async (candidate) => {
      quarantine = candidate;
    })).rejects.toMatchObject({
      message: "The Trash command did not remove the session file",
      status: 502,
    });
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(quarantine!, "utf8")).toContain('"id":"session-a"');
  });
});
