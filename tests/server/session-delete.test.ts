import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteSessionFile } from "../../server/session-delete.js";
import type { SessionRecord } from "../../server/session-catalog.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(
  id = "session-a",
): Promise<{ dir: string; path: string; session: SessionRecord }> {
  const dir = await mkdtemp(join(tmpdir(), "inspire delete-"));
  temporary.push(dir);
  const path = join(dir, `${id}.jsonl`);
  await writeFile(
    path,
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-01T00:00:00.000Z", cwd: dir })}\n`,
  );
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
  it("passes an identity-bound quarantine payload and separate restore path to Trash", async () => {
    const { dir, path, session } = await fixture();
    const trashDir = join(dir, "Trash");
    await mkdir(trashDir);
    const trashed = join(trashDir, "session-a.jsonl");

    await expect(
      deleteSessionFile(session, async (candidate, originalPath) => {
        expect(candidate).not.toBe(path);
        expect(originalPath).toBe(path);
        await rename(candidate, trashed);
      }),
    ).resolves.toBe("trashed");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(trashed, "utf8")).toContain('"id":"session-a"');
  });

  it("falls back to permanent unlink after a failed Trash command", async () => {
    const { path, session } = await fixture();

    await expect(
      deleteSessionFile(session, async () => {
        throw new Error("trash unavailable");
      }),
    ).resolves.toBe("deleted");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a reported Trash failure as success when the file already moved", async () => {
    const { dir, path, session } = await fixture();
    const trashed = join(dir, "trashed.jsonl");

    await expect(
      deleteSessionFile(session, async (candidate) => {
        await rename(candidate, trashed);
        throw new Error("late command failure");
      }),
    ).resolves.toBe("trashed");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a mismatched session header without invoking Trash", async () => {
    const { path, session } = await fixture();
    await writeFile(
      path,
      `${JSON.stringify({ type: "session", version: 3, id: "other" })}\n`,
    );
    let invoked = false;

    await expect(
      deleteSessionFile(session, async () => {
        invoked = true;
      }),
    ).rejects.toMatchObject({
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

    await expect(
      deleteSessionFile(session, async () => undefined),
    ).rejects.toMatchObject({
      message: "The catalog entry is not a regular session file",
      status: 409,
    });
  });

  it("keeps a changed authorized payload isolated after a failed Trash attempt", async () => {
    const { path, session } = await fixture();
    let candidate = "";

    await expect(
      deleteSessionFile(session, async (payload) => {
        candidate = payload;
        await appendFile(
          payload,
          `${JSON.stringify({ type: "message", id: "late-write" })}\n`,
        );
        throw new Error("trash failed");
      }),
    ).rejects.toMatchObject({
      message:
        "The private session payload changed before permanent deletion and was preserved for recovery",
      status: 409,
    });
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(candidate, "utf8")).toContain("late-write");
  });

  it("keeps a public replacement when Trash removes the quarantined original and reports failure", async () => {
    const { dir, path, session } = await fixture();

    await expect(
      deleteSessionFile(session, async (candidate) => {
        await unlink(candidate);
        await writeFile(
          path,
          `${JSON.stringify({ type: "session", version: 3, id: session.id, cwd: dir })}\nreplacement\n`,
        );
        throw new Error("trash failed");
      }),
    ).resolves.toBe("trashed");
    expect(await readFile(path, "utf8")).toContain("replacement");
  });

  it("never lets a Trash pathname consumer target a concurrent public replacement", async () => {
    const { dir, path, session } = await fixture();
    const trashed = join(dir, "trashed-original.jsonl");

    await expect(
      deleteSessionFile(session, async (candidate, originalPath) => {
        await writeFile(originalPath, "public replacement\n");
        await rename(candidate, trashed);
        throw new Error("late command failure");
      }),
    ).resolves.toBe("trashed");
    expect(await readFile(path, "utf8")).toBe("public replacement\n");
    expect(await readFile(trashed, "utf8")).toContain('"id":"session-a"');
  });

  it("never restores a callback replacement from the private pathname", async () => {
    const { dir, path, session } = await fixture();
    const trashed = join(dir, "trashed-original.jsonl");
    let candidate = "";

    await expect(
      deleteSessionFile(session, async (payload) => {
        candidate = payload;
        await rename(payload, trashed);
        await writeFile(payload, "callback replacement\n");
        throw new Error("trash failed");
      }),
    ).rejects.toMatchObject({
      message:
        "The private session payload changed before permanent deletion and was preserved for recovery",
      status: 409,
    });
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(candidate, "utf8")).toBe("callback replacement\n");
    expect(await readFile(trashed, "utf8")).toContain('"id":"session-a"');
  });

  it("writes the original pathname into a Freedesktop Trash entry", async () => {
    const { dir, path, session } = await fixture();
    const dataHome = join(dir, "xdg-data");
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;
    try {
      await expect(deleteSessionFile(session)).resolves.toBe("trashed");
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      const payloads = await readdir(join(dataHome, "Trash", "files"));
      expect(payloads).toHaveLength(1);
      const metadata = await readFile(
        join(dataHome, "Trash", "info", `${payloads[0]}.trashinfo`),
        "utf8",
      );
      expect(metadata).toContain("[Trash Info]\n");
      expect(metadata).toContain(`Path=${path.replaceAll(" ", "%20")}\n`);
      expect(
        await readFile(join(dataHome, "Trash", "files", payloads[0]!), "utf8"),
      ).toContain('"id":"session-a"');
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previous;
    }
  });

  it("retains an unmoved authorized payload privately after a false success", async () => {
    const { path, session } = await fixture();
    let candidate = "";

    await expect(
      deleteSessionFile(session, async (payload, originalPath) => {
        candidate = payload;
        expect(payload).not.toBe(path);
        expect(originalPath).toBe(path);
      }),
    ).rejects.toMatchObject({
      message: "The Trash operation did not move the session payload",
      status: 502,
    });
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(candidate, "utf8")).toContain('"id":"session-a"');
  });
});
