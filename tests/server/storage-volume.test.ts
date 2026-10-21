import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readRootIdentity,
  RETENTION_MARKER,
} from "../../server/attachment-retention-identity.js";
import {
  nativeMacosVolumeIdentities,
  nativeWindowsVolumeIdentities,
  resolveStorageVolume,
  snapshotStorageVolumes,
  type StorageVolumeOptions,
} from "../../server/storage-volume.js";

const native = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: async (
      ...args: unknown[]
    ) => ({ stdout: await native.run(...args), stderr: "" }),
  }),
}));
const roots: string[] = [];
afterEach(async () => {
  native.run.mockReset();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const id = "12345678-1234-4234-8234-123456789abc";
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-storage-volume-")),
  );
  roots.push(root);
  const volume = join(root, "external-volume"),
    sessions = join(volume, "sessions"),
    parent = join(root, "uploads");
  await mkdir(sessions, { recursive: true });
  await mkdir(parent);
  let mounts = [
    {
      id: 1,
      mountPoint: root,
      root: "/",
      filesystem: "fixture",
      source: "home-filesystem",
    },
    {
      id: 2,
      mountPoint: volume,
      root: "/",
      filesystem: "fixture",
      source: "external-filesystem",
    },
  ];
  const options: StorageVolumeOptions = {
    parent,
    platform: "linux",
    linux: {
      uid: process.getuid?.() ?? 0,
      mounts: async () => mounts,
    },
  };
  return {
    root,
    volume,
    sessions,
    parent,
    options,
    homeFilesystem: () => {
      mounts = mounts.slice(0, 1);
    },
  };
}
describe("persistent volume proof placement", () => {
  it("uses private Inspire metadata on the same filesystem outside the session root", async () => {
    const f = await fixture();
    f.homeFilesystem();
    const proof = await resolveStorageVolume(
      f.sessions,
      f.options,
      readRootIdentity,
      undefined,
      true,
    );
    expect(proof.identity.kind).toBe("linux-anchor");
    expect(proof.identity.directory).toBe(
      join(f.parent, ".inspire-retention-volume"),
    );
    await proof.verify();
    const bytes = await readFile(
      join(proof.identity.directory, RETENTION_MARKER),
      "utf8",
    );
    expect(bytes).toContain(proof.identity.id);
  });
  it("anchors an external filesystem independently of session storage and native Trash", async () => {
    const f = await fixture();
    const proof = await resolveStorageVolume(
      f.sessions,
      f.options,
      readRootIdentity,
      undefined,
      true,
    );
    expect(proof.identity.directory).toBe(
      join(f.volume, ".inspire-retention-" + (process.getuid?.() ?? 0)),
    );
    expect(proof.identity.directory).not.toContain(".Trash");
    await rm(f.sessions, { recursive: true });
    expect((await readRootIdentity(proof.identity.directory)).id).toBe(
      proof.identity.id,
    );
  });
  it("rejects anchors inside the root or any subtree, including a symlinked state-parent alias", async () => {
    const f = await fixture();
    const alias = join(f.root, "state-alias");
    await symlink(
      f.volume,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      resolveStorageVolume(
        f.volume,
        { ...f.options, parent: alias },
        readRootIdentity,
        undefined,
        true,
      ),
    ).rejects.toThrow("outside session storage");
    await expect(
      readRootIdentity(join(f.volume, ".inspire-retention-volume")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("defers a changed volume anchor despite an unchanged session directory marker", async () => {
    const f = await fixture(),
      proof = await resolveStorageVolume(
        f.sessions,
        f.options,
        readRootIdentity,
        undefined,
        true,
      );
    await rename(proof.identity.directory, join(f.volume, "original-anchor"));
    await mkdir(proof.identity.directory);
    await readRootIdentity(proof.identity.directory, true);
    await expect(
      resolveStorageVolume(
        f.sessions,
        f.options,
        readRootIdentity,
        proof.identity,
      ),
    ).rejects.toThrow("anchor changed");
  });
  it("does not create an unknown anchor during an ordinary read-only identity query", async () => {
    const f = await fixture();
    await expect(
      resolveStorageVolume(f.sessions, f.options, readRootIdentity),
    ).rejects.toThrow();
    await expect(
      readRootIdentity(
        join(f.volume, ".inspire-retention-" + (process.getuid?.() ?? 0)),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("native persistent identity command contracts (mocked)", () => {
  it("batches Foundation filesystem UUIDs, not mount-lifetime volumeIdentifier values", async () => {
    const root = join(tmpdir(), "owned-volume-query");
    const paths = [join(root, "one's sessions"), join(root, "two")];
    native.run
      .mockResolvedValue(
        paths.map(() => ({ directory: root, id: id.toUpperCase() })),
      )
      .mockImplementationOnce(async (_command, args) => {
        expect(args[3]).toContain("NSURLVolumeUUIDStringKey");
        expect(args[3]).not.toContain("NSURLVolumeIdentifierKey");
        expect(args[3]).not.toContain(paths[0]);
        expect(args.slice(4)).toEqual(paths);
        return JSON.stringify(
          paths.map(() => ({ directory: root, id: id.toUpperCase() })),
        );
      });
    expect(await nativeMacosVolumeIdentities(paths)).toEqual(
      paths.map(() => ({ kind: "macos-uuid", directory: root, id })),
    );
  });
  it("combines mounted-folder volume GUID and filesystem serial using data-only environment paths", async () => {
    const root = join(tmpdir(), "mounted-volume"),
      paths = [join(root, "quote';$ folder")];
    native.run.mockImplementation(async (_command, args, options) => {
      const script = args.at(-1);
      expect(script).toContain("GetVolumePathName");
      expect(script).toContain("GetVolumeNameForVolumeMountPoint");
      expect(script).toContain("GetVolumeInformation");
      expect(script).not.toContain(paths[0]);
      expect(JSON.parse(options.env.INSPIRE_RETENTION_PATHS)).toEqual(paths);
      return JSON.stringify([
        {
          directory: root,
          id: "\\\\?\\Volume{" + id.toUpperCase() + "}\\",
          format: "0123abcd",
        },
      ]);
    });
    expect(await nativeWindowsVolumeIdentities(paths)).toEqual([
      { kind: "windows-guid", directory: root, id, format: "0123abcd" },
    ]);
  });
  it("rejects a missing UUID or unavailable UNC identity instead of using paths/serial alone", async () => {
    native.run.mockResolvedValue(
      JSON.stringify([{ directory: tmpdir(), id: null }]),
    );
    await expect(nativeMacosVolumeIdentities([tmpdir()])).rejects.toThrow(
      "UUID",
    );
    native.run.mockResolvedValue(
      JSON.stringify([
        { directory: tmpdir(), id: "serial-only", format: "12345678" },
      ]),
    );
    await expect(nativeWindowsVolumeIdentities([tmpdir()])).rejects.toThrow(
      "GUID",
    );
  });
  it.each(["windows-guid", "macos-uuid"] as const)(
    "snapshots %s in two batches for multiple roots",
    async (kind) => {
      const f = await fixture();
      const paths = [f.sessions, f.parent],
        query = vi.fn(async (paths: readonly string[]) =>
          paths.map(() => ({
            kind,
            directory: f.root,
            id,
            ...(kind === "windows-guid" ? { format: "01234567" } : {}),
          })),
        );
      const batch = await snapshotStorageVolumes(paths, {
        parent: f.parent,
        platform: kind === "windows-guid" ? "win32" : "darwin",
        nativeIdentities: query,
      });
      const a = await resolveStorageVolume(
        f.sessions,
        batch.options,
        readRootIdentity,
      );
      const b = await resolveStorageVolume(
        f.parent,
        batch.options,
        readRootIdentity,
      );
      await a.verify();
      await b.verify();
      expect(query).toHaveBeenCalledTimes(1);
      await batch.verify();
      expect(query).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["darwin", "win32"] as const)(
    "chunks long %s root collections within input/output budgets and preserves order",
    async (platform) => {
      const paths = Array.from({ length: 80 }, (_, index) =>
        join(tmpdir(), "owned-query", String(index), "路径 ".repeat(500)),
      );
      native.run.mockImplementation(async (_command, args, options) => {
        const chunk: string[] =
          platform === "win32"
            ? JSON.parse(options.env.INSPIRE_RETENTION_PATHS)
            : args.slice(4);
        expect(JSON.stringify(chunk).length).toBeLessThan(30000);
        const output = JSON.stringify(
          chunk.map((path) => ({
            directory: path,
            id: platform === "win32" ? "\\\\?\\Volume{" + id + "}\\" : id,
            ...(platform === "win32" ? { format: "12345678" } : {}),
          })),
        );
        expect(Buffer.byteLength(output, "utf8")).toBeLessThan(
          options.maxBuffer,
        );
        return output;
      });
      const results = await (platform === "win32"
        ? nativeWindowsVolumeIdentities
        : nativeMacosVolumeIdentities)(paths);
      expect(results.map((identity) => identity.directory)).toEqual(paths);
      expect(native.run.mock.calls.length).toBeGreaterThan(1);
      expect(native.run.mock.calls.length).toBeLessThan(paths.length);
    },
  );

  it("rejects a reformatted Windows filesystem even when its Mount Manager GUID is unchanged", async () => {
    const f = await fixture(),
      expected = {
        kind: "windows-guid" as const,
        directory: f.root,
        id,
        format: "01234567",
      };
    await expect(
      resolveStorageVolume(
        f.sessions,
        {
          parent: f.parent,
          platform: "win32",
          nativeIdentity: async () => ({ ...expected, format: "deadbeef" }),
        },
        readRootIdentity,
        expected,
      ),
    ).rejects.toThrow("volume changed");
  });
});
