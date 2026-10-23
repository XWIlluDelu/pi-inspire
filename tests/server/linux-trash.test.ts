import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moveToDesktopTrash } from "../../server/desktop-trash.js";
import {
  type LinuxMount,
  linuxDirectoryAuthority,
  linuxMounts,
  parseLinuxMountInfo,
  selectLinuxTrash,
} from "../../server/linux-trash.js";
import { deleteSessionFile } from "../../server/session-delete.js";
import { SessionMetadataIndex } from "../../server/session-metadata.js";

const roots: string[] = [];
const uid = process.getuid?.() ?? 1000;
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function ownedRoot(parent = tmpdir()) {
  const root = await realpath(
    await mkdtemp(join(parent, "inspire-linux-trash-")),
  );
  roots.push(root);
  return root;
}
function mount(mountPoint: string, id: number, source = "fixture"): LinuxMount {
  return { id, mountPoint, root: "/", filesystem: "fixture-fs", source };
}
async function fixture(sourceParent?: string) {
  const home = await ownedRoot();
  const volume = sourceParent
    ? await ownedRoot(sourceParent)
    : join(home, "volume");
  await mkdir(volume, { recursive: true });
  const sessions = join(volume, "sessions");
  await mkdir(sessions);
  const original = join(sessions, "session 空格 #%.jsonl");
  const payload = join(sessions, ".inspire-delete-owned", "payload.jsonl");
  await mkdir(dirname(payload));
  await writeFile(
    payload,
    JSON.stringify({ type: "session", id: "session-a", cwd: home }) + "\n",
  );
  const mounts = [mount(home, 1), mount(volume, 2)];
  const options = {
    home,
    environment: { XDG_DATA_HOME: join(home, "data") },
    uid,
    mounts: async () => mounts,
  };
  return { home, volume, sessions, original, payload, mounts, options };
}

describe("Linux mountinfo", () => {
  it("decodes escaped roots/mountpoints and preserves bind-mount identity", () => {
    const mounts = parseLinuxMountInfo(
      "10 1 8:1 / / rw shared:1 - ext4 /dev/test rw\n" +
        "11 10 8:1 /some\\040directory /media/bind\\040view rw - ext4 /dev/test rw\n",
    );
    expect(mounts).toEqual([
      {
        id: 10,
        mountPoint: "/",
        root: "/",
        filesystem: "ext4",
        source: "/dev/test",
      },
      {
        id: 11,
        mountPoint: "/media/bind view",
        root: "/some directory",
        filesystem: "ext4",
        source: "/dev/test",
      },
    ]);
  });
  it("rejects missing or malformed mount authority", () => {
    expect(() => parseLinuxMountInfo("")).toThrow("authority");
    expect(() => parseLinuxMountInfo("unrecognized mount record")).toThrow(
      "mountinfo",
    );
  });
});

describe.skipIf(process.platform !== "linux")(
  "source-volume Freedesktop Trash",
  () => {
    it("uses private topdir Trash across distinct logical bind mounts on the same device", async () => {
      const { volume, payload, original, options } = await fixture();
      const before = await lstat(payload);
      const { root, restorePath } = await selectLinuxTrash(
        payload,
        original,
        options,
      );
      expect(root).toBe(join(volume, ".Trash-" + uid));
      expect(restorePath).toBe("sessions/session 空格 #%.jsonl");
      await moveToDesktopTrash(payload, original, {
        platform: "linux",
        ...options,
        linux: options,
      });
      const entries = await readdir(join(root, "files"));
      expect(entries).toHaveLength(1);
      const moved = await lstat(join(root, "files", entries[0]!));
      expect([moved.dev, moved.ino]).toEqual([before.dev, before.ino]);
      const info = await readFile(
        join(root, "info", entries[0] + ".trashinfo"),
        "utf8",
      );
      expect(info).toContain(
        "Path=sessions/session%20%E7%A9%BA%E6%A0%BC%20%23%25.jsonl\n",
      );
      expect(info).not.toContain(".inspire-delete-");
      await expect(lstat(payload)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("uses available source-volume Trash when same-mount home Trash is unsafe", async () => {
      const { volume, home, payload, original, options } = await fixture();
      options.mounts = async () => [mount(home, 1)];
      await mkdir(join(home, "data"));
      await symlink(volume, join(home, "data", "Trash"));
      const selected = await selectLinuxTrash(payload, original, options);
      expect(selected.root).toBe(join(home, ".Trash-" + uid));
      expect(selected.restorePath).toBe(
        "volume/sessions/session 空格 #%.jsonl",
      );
      expect((await lstat(join(home, "data", "Trash"))).isSymbolicLink()).toBe(
        true,
      );
    });

    it("prefers validated sticky shared Trash", async () => {
      const { volume, payload, original, options } = await fixture();
      const shared = join(volume, ".Trash");
      await mkdir(shared);
      await chmod(shared, 0o1777);
      const selection = await selectLinuxTrash(payload, original, options);
      expect(selection.root).toBe(join(shared, String(uid)));
    });

    it.each(["non-sticky", "symlink", "unusable-user-directory"])(
      "falls back without changing an unsafe/unusable shared Trash: %s",
      async (kind) => {
        const { volume, home, payload, original, options } = await fixture();
        const shared = join(volume, ".Trash");
        if (kind === "symlink") await symlink(home, shared);
        else {
          await mkdir(shared);
          await chmod(shared, kind === "non-sticky" ? 0o755 : 0o1777);
          if (kind === "unusable-user-directory")
            await symlink(home, join(shared, String(uid)));
        }
        const before = await lstat(shared);
        expect((await selectLinuxTrash(payload, original, options)).root).toBe(
          join(volume, ".Trash-" + uid),
        );
        expect((await lstat(shared)).mode).toBe(before.mode);
      },
    );

    it("refuses a symlinked private volume Trash without touching its target or payload", async () => {
      const { volume, home, payload, original, options } = await fixture();
      await symlink(home, join(volume, ".Trash-" + uid));
      await expect(
        selectLinuxTrash(payload, original, options),
      ).rejects.toThrow("non-symlink");
      await expect(lstat(payload)).resolves.toBeDefined();
      expect(await readdir(home)).toEqual(["volume"]);
    });

    it("preserves inode and returns trashed for actual /dev/shm bytes instead of EXDEV fallback", async (context) => {
      try {
        if ((await lstat("/dev/shm")).dev === (await lstat(tmpdir())).dev)
          return context.skip();
      } catch {
        return context.skip();
      }
      const { volume, home, sessions, original, payload, options } =
        await fixture("/dev/shm");
      await rm(dirname(payload), { recursive: true });
      const contents =
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-a",
          cwd: home,
        }) + "\n";
      await writeFile(original, contents);
      const before = await lstat(original);
      const record = (await new SessionMetadataIndex().list([sessions]))[0]!;
      await expect(
        deleteSessionFile(record, (privatePath, path) =>
          moveToDesktopTrash(privatePath, path, {
            platform: "linux",
            ...options,
            linux: options,
          }),
        ),
      ).resolves.toBe("trashed");
      const trash = join(volume, ".Trash-" + uid);
      const names = await readdir(join(trash, "files"));
      const destination = join(trash, "files", names[0]!);
      expect(await readFile(destination, "utf8")).toBe(contents);
      const moved = await lstat(destination);
      expect([moved.dev, moved.ino]).toEqual([before.dev, before.ino]);
      expect(await readdir(sessions)).toEqual([]);
      // Every path created by the adapter is below this owned logical topdir.
      expect(await readdir(volume)).toEqual([".Trash-" + uid, "sessions"]);
    });

    it("resolves the real kernel namespace without modifying its Trash", async () => {
      const mounts = await linuxMounts();
      const root = await ownedRoot();
      expect(
        (await linuxDirectoryAuthority(root, mounts)).mount.id,
      ).toBeGreaterThan(0);
    });
  },
);
