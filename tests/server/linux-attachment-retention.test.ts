import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { sessionAttachmentReferences } from "../../server/attachment-references.js";
import {
  readRootIdentity,
  trustSessionDirectory,
} from "../../server/attachment-retention-identity.js";
import { moveToDesktopTrash } from "../../server/desktop-trash.js";
import {
  type LinuxMount,
  type LinuxTrashOptions,
  linuxSessionTrashDirectories,
} from "../../server/linux-trash.js";
import { deleteSessionFile } from "../../server/session-delete.js";
import { SessionMetadataIndex } from "../../server/session-metadata.js";

vi.mock("../../server/attachment-references.js", async (importOriginal) => {
  const module =
    await importOriginal<
      typeof import("../../server/attachment-references.js")
    >();
  return {
    ...module,
    sessionAttachmentReferences: vi.fn(module.sessionAttachmentReferences),
  };
});
let root: string, volume: string, sessions: string, uploads: string;
let mounts: LinuxMount[];
let linux: LinuxTrashOptions;
const stores: AttachmentStore[] = [];
const uid = process.getuid?.() ?? 1000;
function openStore(directories = [sessions]) {
  const store = new AttachmentStore(uploads, null, {
    sessionDirectories: directories,
    linux,
    sweepIntervalMs: 0,
  });
  stores.push(store);
  return store;
}
async function piSession(file: string, attachment?: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "retained",
        cwd: root,
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: attachment ?? "hello" }],
        },
      }),
    ].join("\n") + "\n",
  );
}
async function retained(store: AttachmentStore) {
  const doc = await store.add({
    originalname: "retained.txt",
    mimetype: "text/plain",
    size: 5,
    buffer: Buffer.from("hello"),
  } as Express.Multer.File);
  const { files } = await store.resolveForPrompt([doc.id]);
  const path = files[0]!.path,
    file = join(sessions, "retained.jsonl");
  await piSession(file, path);
  await store.registerSession(file);
  await store.releaseConsumed([doc.id], file);
  return { path, file };
}
async function registry() {
  return JSON.parse(
    await readFile(join(uploads, ".session-directories.json"), "utf8"),
  );
}
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-linux-retention-")),
  );
  volume = join(root, "volume");
  sessions = join(volume, "sessions");
  uploads = join(root, `1073741823-100-${randomUUID()}`);
  await mkdir(sessions, { recursive: true });
  mounts = [
    {
      id: 1,
      mountPoint: root,
      root: "/",
      filesystem: "fixture",
      source: "home-volume",
    },
    {
      id: 2,
      mountPoint: volume,
      root: "/source-subtree",
      filesystem: "fixture",
      source: "external-volume",
    },
  ];
  linux = {
    home: root,
    environment: { XDG_DATA_HOME: join(root, "data") },
    uid,
    mounts: async () => mounts,
  };
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe.skipIf(process.platform !== "linux")(
  "Linux volume-local namespace retention",
  () => {
    it("scans source-volume Trash across restart while retaining its source namespace marker", async () => {
      let store = openStore();
      const { path } = await retained(store);
      const record = (await new SessionMetadataIndex().list([sessions]))[0]!;
      expect(
        await deleteSessionFile(record, (payload, original) =>
          moveToDesktopTrash(payload, original, {
            platform: "linux",
            home: root,
            environment: linux.environment,
            linux,
          }),
        ),
      ).toBe("trashed");
      await store.close();
      store = openStore();
      expect(await store.collectUnreferenced()).toEqual({ reclaimed: [] });
      const stored = await registry();
      expect(stored.version).toBe(3);
      expect(stored.identities[sessions]).toMatchObject({
        directory: sessions,
        id: (await readRootIdentity(sessions)).id,
      });
      await rm(join(volume, ".Trash-" + uid), { recursive: true });
      expect((await store.collectUnreferenced()).reclaimed).toEqual([path]);
    });

    it("defers an offline/replaced namespace even when the mount topology is identical after restart", async () => {
      let store = openStore();
      const { path, file } = await retained(store);
      const before = await registry();
      await store.close();
      await rename(volume, join(root, "offline-volume"));
      await mkdir(sessions, { recursive: true });
      store = openStore();
      expect((await store.collectUnreferenced()).deferred).toContain(
        "marker is unavailable",
      );
      await piSession(file, path);
      await expect(store.registerSession(file)).resolves.toBeUndefined();
      expect((await store.collectUnreferenced()).deferred).toContain(
        "marker is unavailable",
      );
      expect(await registry()).toEqual(before);
      await expect(access(path)).resolves.toBeUndefined();
    });

    it.each(["source", "filesystem"] as const)(
      "accepts namespace continuity despite a changed mount %s across restart",
      async (field) => {
        let store = openStore();
        const { path, file } = await retained(store),
          expected = await registry();
        await rm(file);
        await store.close();
        mounts = mounts.map((mount) =>
          mount.mountPoint === volume
            ? { ...mount, [field]: mount[field] + "-changed" }
            : mount,
        );
        store = openStore();
        expect(await store.collectUnreferenced()).toEqual({
          reclaimed: [path],
        });
        expect(await registry()).toEqual(expected);
      },
    );

    it("defers a changed bind-mount root even when root marker and filesystem anchor survive", async () => {
      let store = openStore();
      const { path, file } = await retained(store),
        before = await registry();
      await rm(file);
      await store.close();
      mounts = mounts.map((mount) =>
        mount.mountPoint === volume
          ? { ...mount, root: "/different-source-subtree" }
          : mount,
      );
      store = openStore();
      expect((await store.collectUnreferenced()).deferred).toContain(
        "scope changed",
      );
      expect(await registry()).toEqual(before);
      await expect(access(path)).resolves.toBeUndefined();
    });

    it("rejects a copied session marker on replacement storage until original Trash references are migrated and explicitly trusted", async () => {
      let store = openStore();
      const { path, file } = await retained(store),
        before = await registry();
      const bin = join(volume, ".Trash-" + uid);
      await mkdir(join(bin, "files"), { recursive: true, mode: 0o700 });
      await rename(file, join(bin, "files", "retained.jsonl"));
      expect(await store.sessionDeleted(file)).toEqual({ reclaimed: [] });
      await store.close();
      const offline = join(root, "old-volume");
      await rename(volume, offline);
      await mkdir(volume);
      await cp(join(offline, "sessions"), sessions, { recursive: true });
      // Source name, mount point/root/type and copied root marker all match.
      // The independent volume anchor and old Trash were NOT copied.
      store = openStore();
      expect((await store.collectUnreferenced()).deferred).toBeDefined();
      await expect(access(path)).resolves.toBeUndefined();
      expect(await registry()).toEqual(before);
      await store.close();
      await cp(join(offline, ".Trash-" + uid), bin, { recursive: true });
      await trustSessionDirectory(sessions, {
        parent: root,
        confirm: true,
        volume: { linux },
      });
      store = openStore();
      expect(await store.collectUnreferenced()).toEqual({ reclaimed: [] });
      await rm(bin, { recursive: true });
      expect(await store.collectUnreferenced()).toEqual({ reclaimed: [path] });
    });

    it("does not persist ephemeral mount IDs as directory identity", async () => {
      let store = openStore();
      const { path, file } = await retained(store);
      const expected = await registry();
      await store.close();
      mounts = mounts.map((mount) => ({ ...mount, id: mount.id + 100 }));
      store = openStore();
      expect(await store.collectUnreferenced()).toEqual({ reclaimed: [] });
      await rm(file);
      expect((await store.collectUnreferenced()).reclaimed).toEqual([path]);
      expect(await registry()).toEqual(expected);
      expect(Object.keys(expected.identities[sessions]).sort()).toEqual([
        "directory",
        "id",
        "volume",
      ]);
    });

    it("preserves all v1 paths and requires explicit offline trust even with current Pi headers", async () => {
      let store = openStore();
      const { path } = await retained(store),
        other = join(volume, "other-sessions");
      await piSession(join(other, "other.jsonl"));
      await writeFile(
        join(uploads, ".session-directories.json"),
        JSON.stringify([sessions, other]),
      );
      await store.close();
      store = openStore();
      expect((await store.collectUnreferenced()).deferred).toContain(
        "Unverified session retention",
      );
      expect(await registry()).toEqual([sessions, other]);
      await store.close();
      await trustSessionDirectory(sessions, {
        parent: root,
        confirm: true,
        volume: { linux },
      });
      await trustSessionDirectory(other, {
        parent: root,
        confirm: true,
        volume: { linux },
      });
      store = openStore();
      expect(await store.collectUnreferenced()).toEqual({ reclaimed: [] });
      expect(new Set((await registry()).directories)).toEqual(
        new Set([sessions, other]),
      );
      await expect(access(path)).resolves.toBeUndefined();
    });

    it("ignores a never-used missing configured root without creating it", async () => {
      let store = openStore();
      const { path, file } = await retained(store);
      await rm(file);
      await store.close();
      const unused = join(root, "unused-default", "sessions");
      store = openStore([sessions, unused]);
      expect(await store.collectUnreferenced()).toEqual({ reclaimed: [path] });
      await expect(access(unused)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("defers unreadable source-volume Trash without changing its permissions", async (context) => {
      if (uid === 0) return context.skip();
      const store = openStore(),
        { path, file } = await retained(store);
      await rm(file);
      const bin = join(volume, ".Trash-" + uid);
      await mkdir(join(bin, "files"), { recursive: true, mode: 0o700 });
      await chmod(bin, 0);
      try {
        expect((await store.collectUnreferenced()).deferred).toBeDefined();
        await expect(access(path)).resolves.toBeUndefined();
      } finally {
        await chmod(bin, 0o700);
      }
    });

    it("watches absent candidate Trash roots created after discovery", async () => {
      const store = openStore(),
        { path, file } = await retained(store);
      const candidates = await linuxSessionTrashDirectories(mounts, linux),
        bin = join(volume, ".Trash-" + uid, "files");
      await mkdir(bin, { recursive: true, mode: 0o700 });
      await rename(file, join(bin, "retained.jsonl"));
      const references = await sessionAttachmentReferences(
        new Set([path]),
        [sessions],
        candidates,
        new Map(),
      );
      expect(references.paths.has(path)).toBe(true);
    });

    it("rechecks mount membership across the entire reference sweep", async () => {
      const store = openStore(),
        { path, file } = await retained(store);
      await rm(file);
      const actual = await vi.importActual<
        typeof import("../../server/attachment-references.js")
      >("../../server/attachment-references.js");
      vi.mocked(sessionAttachmentReferences).mockImplementationOnce(
        async (...args) => {
          const result = await actual.sessionAttachmentReferences(...args);
          mounts = mounts.map((mount) => ({ ...mount, id: mount.id + 100 }));
          return result;
        },
      );
      expect((await store.collectUnreferenced()).deferred).toContain(
        "mount changed during",
      );
      await expect(access(path)).resolves.toBeUndefined();
    });

    it("scans private Trash even after shared Trash becomes the preferred layout", async () => {
      const store = openStore(),
        { path, file } = await retained(store);
      const privateTrash = join(volume, ".Trash-" + uid);
      await mkdir(join(privateTrash, "files"), {
        recursive: true,
        mode: 0o700,
      });
      await rename(file, join(privateTrash, "files", "retained.jsonl"));
      await mkdir(join(volume, ".Trash"));
      await chmod(join(volume, ".Trash"), 0o1777);
      expect(await store.collectUnreferenced()).toEqual({ reclaimed: [] });
      await expect(access(path)).resolves.toBeUndefined();
    });
  },
);
