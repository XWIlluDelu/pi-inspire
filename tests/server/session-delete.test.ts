import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRecord } from "../../server/session-catalog.js";
import { deleteSessionFile } from "../../server/session-delete.js";

const temporary: string[] = [];

async function source(path: string): Promise<SessionRecord["source"]> {
  const details = await stat(path, { bigint: true });
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeNs: details.mtimeNs,
    ctimeNs: details.ctimeNs,
  };
}

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
      source: await source(path),
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

  it("does not turn committed deletion into a retryable failure when container cleanup fails", async () => {
    const trashedFixture = await fixture("trashed-cleanup");
    const trashDestination = join(trashedFixture.dir, "trashed.jsonl");
    const deletedFixture = await fixture("deleted-cleanup");
    const failCleanup = async () => {
      throw Object.assign(new Error("cleanup unavailable"), { code: "EACCES" });
    };

    await expect(
      deleteSessionFile(
        trashedFixture.session,
        async (candidate) => rename(candidate, trashDestination),
        failCleanup,
      ),
    ).resolves.toBe("trashed");
    await expect(
      deleteSessionFile(
        deletedFixture.session,
        async () => {
          throw new Error("trash unavailable");
        },
        failCleanup,
      ),
    ).resolves.toBe("deleted");
    await expect(readFile(trashedFixture.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(deletedFixture.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
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

  it("refuses a session that changed since its catalog record", async () => {
    const { path, session } = await fixture();
    await appendFile(
      path,
      `${JSON.stringify({ type: "message", id: "external" })}\n`,
    );

    await expect(
      deleteSessionFile(session, async () => undefined),
    ).rejects.toMatchObject({
      message: "The session changed since the catalog was loaded",
      status: 409,
    });
    await expect(readFile(path, "utf8")).resolves.toContain('"external"');
  });

  it("refuses a mismatched session header without invoking Trash", async () => {
    const { path, session } = await fixture();
    await writeFile(
      path,
      `${JSON.stringify({ type: "session", version: 3, id: "other" })}\n`,
    );
    session.source = await source(path);
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

  it("refuses a header whose working directory no longer matches the catalog", async () => {
    const { path, session } = await fixture();
    await writeFile(
      path,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: session.id,
        cwd: join(session.cwd, "moved"),
      })}\n`,
    );
    session.source = await source(path);

    await expect(
      deleteSessionFile(session, async () => undefined),
    ).rejects.toMatchObject({
      message: "The session file identity does not match the catalog",
      status: 409,
    });
  });

  it.runIf(process.platform !== "win32")(
    "refuses a symbolic-link catalog path",
    async () => {
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
        source: await source(path),
      };

      await expect(
        deleteSessionFile(session, async () => undefined),
      ).rejects.toMatchObject({
        message: "The catalog entry is not a regular session file",
        status: 409,
      });
    },
  );

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
