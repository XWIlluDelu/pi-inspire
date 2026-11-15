import { execFile } from "node:child_process";
import {
  appendFile,
  cp,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moveToDesktopTrash } from "../../server/desktop-trash.js";
import type { SessionRecord } from "../../server/session-catalog.js";
import { deleteSessionFile } from "../../server/session-delete.js";
import {
  RECOVERY_MANIFEST,
  RECOVERY_README,
} from "../../server/session-recovery.js";

const temporary: string[] = [];
const run = promisify(execFile);

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
  const dir = await mkdtemp(join(await realpath(tmpdir()), "inspire delete-"));
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
      source: await source(path),
    },
  };
}

describe("session file deletion", () => {
  it("classifies a missing source without touching Trash", async () => {
    const { path, session } = await fixture();
    await rm(path);
    const trash = vi.fn();
    await expect(deleteSessionFile(session, trash)).rejects.toMatchObject({
      status: 404,
      code: "SESSION_FILE_MISSING",
    });
    expect(trash).not.toHaveBeenCalled();
  });

  it("restores a copied native Trash bundle through the launcher and protects newer session bytes", async () => {
    const { dir, path, session } = await fixture("session 空格 #");
    const original = await readFile(path, "utf8");
    const bundle = join(dir, "isolated native trash bundle");
    await expect(
      deleteSessionFile(session, (payload, origin) =>
        moveToDesktopTrash(payload, origin, {
          platform: "win32",
          environment: {},
          home: dir,
          windowsRecycle: (directory) => rename(directory, bundle),
        }),
      ),
    ).resolves.toBe("trashed");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(dir)).toEqual([basename(bundle)]);

    const restored = join(dir, "copied recovery bundle");
    await cp(bundle, restored, { recursive: true });
    const payload = join(restored, basename(path));
    expect((await stat(payload)).ino).not.toBe(
      (await stat(join(bundle, basename(path)))).ino,
    );
    const launcher = fileURLToPath(
      new URL("../../inspire.mjs", import.meta.url),
    );
    const recover = () =>
      run(process.execPath, [launcher, "recover-session", basename(restored)], {
        cwd: dir,
        timeout: 15_000,
      });
    const { stdout } = await recover();
    expect(stdout).toContain("Recovered session: " + path);
    expect(stdout).toContain("Recovery bundle retained");
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await stat(path)).ino).not.toBe((await stat(payload)).ino);
    expect((await readdir(restored)).sort()).toEqual(
      [RECOVERY_MANIFEST, RECOVERY_README, basename(path)].sort(),
    );

    await writeFile(path, "newer session\n");
    await expect(recover()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("already exists"),
    });
    expect(await readFile(path, "utf8")).toBe("newer session\n");
    expect(await readFile(payload, "utf8")).toBe(original);
  });

  it("cleans native recovery metadata after identity-checked permanent fallback", async () => {
    const { dir, path, session } = await fixture();
    await expect(
      deleteSessionFile(session, (payload, origin) =>
        moveToDesktopTrash(payload, origin, {
          platform: "darwin",
          environment: {},
          home: dir,
          macosRecycle: async () => {
            throw new Error("native Trash unavailable");
          },
        }),
      ),
    ).resolves.toBe("deleted");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(dir)).toEqual([]);
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

  it("deletes the current version of the catalog object after normal writes", async () => {
    const { dir, path, session } = await fixture();
    await appendFile(path, '{"type":"message","id":"new-message"}\n');
    const trashed = join(dir, "trashed.jsonl");

    await expect(
      deleteSessionFile(session, (payload) => rename(payload, trashed)),
    ).resolves.toBe("trashed");
    expect(await readFile(trashed, "utf8")).toContain('"new-message"');
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not authorize a replacement inode when pinning the current version", async () => {
    const { dir, path, session } = await fixture();
    const content = await readFile(path);
    await rename(path, join(dir, "original.jsonl"));
    await writeFile(path, content);

    const trash = vi.fn();
    await expect(deleteSessionFile(session, trash)).rejects.toMatchObject({
      status: 409,
      code: "SESSION_CATALOG_STALE",
    });
    expect(trash).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(content);
  });

  it.each(["id", "cwd"] as const)(
    "revalidates a changed header %s on the same inode before Trash",
    async (field) => {
      const { path, session } = await fixture();
      const header = {
        type: "session",
        version: 3,
        id: session.id,
        cwd: session.cwd,
        [field]: field === "id" ? "other" : join(session.cwd, "moved"),
      };
      const contents = JSON.stringify(header) + "\n";
      await writeFile(path, contents);
      const trash = vi.fn();

      await expect(deleteSessionFile(session, trash)).rejects.toMatchObject({
        code: "SESSION_CATALOG_STALE",
        status: 409,
      });
      expect(trash).not.toHaveBeenCalled();
      expect(await readFile(path, "utf8")).toBe(contents);
    },
  );

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
