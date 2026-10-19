import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionAttachmentReferences } from "../../server/attachment-references.js";
import {
  RETENTION_MARKER,
  RETENTION_REGISTRY,
  readRootIdentity,
  trustSessionDirectory as trustDirectory,
  withRetentionMaintenance,
} from "../../server/attachment-retention-identity.js";
import { AttachmentStore } from "../../server/attachments.js";

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
async function trustSessionDirectory(
  directory: string,
  options: Parameters<typeof trustDirectory>[1] = {},
) {
  const root = options.parent!;
  return trustDirectory(directory, {
    ...options,
    volume: {
      platform: "linux",
      linux: {
        uid: process.getuid?.() ?? 0,
        mounts: async () => [
          {
            id: 1,
            mountPoint: root,
            root: "/",
            filesystem: "fixture",
            source: "same-volume-source",
          },
        ],
      },
    },
  });
}
const roots: string[] = [],
  stores: AttachmentStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function fixture(
  platform: NodeJS.Platform = "linux",
  volumeOverride?: import("../../server/storage-volume.js").StorageVolumeOptions,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-retention-identity-")),
  );
  roots.push(root);
  const sessions = join(root, "sessions"),
    trash = join(root, "Trash");
  await mkdir(sessions);
  const uploads = join(root, `1073741823-100-${randomUUID()}`);
  function open(uploadRoot = uploads, cleanupParent: string | null = null) {
    const store = new AttachmentStore(uploadRoot, cleanupParent, {
      sessionDirectories: [sessions],
      trashDirectories: [trash],
      sweepIntervalMs: 0,
      volume:
        volumeOverride ??
        (platform === "linux"
          ? { platform }
          : {
              platform,
              nativeIdentity: async () => ({
                kind: platform === "win32" ? "windows-guid" : "macos-uuid",
                directory: parse(root).root,
                id: "12345678-1234-4234-8234-123456789abc",
                ...(platform === "win32" ? { format: "12345678" } : {}),
              }),
            }),
      linux: {
        uid: process.getuid?.() ?? 0,
        mounts: async () => [
          {
            id: 1,
            mountPoint: root,
            root: "/",
            filesystem: "fixture",
            source: "same-volume-source",
          },
        ],
      },
    });
    stores.push(store);
    return store;
  }
  let store = open();
  const doc = await store.add({
    originalname: "notes.txt",
    mimetype: "text/plain",
    size: 5,
    buffer: Buffer.from("hello"),
  } as Express.Multer.File);
  const { files } = await store.resolveForPrompt([doc.id]);
  const upload = files[0]!.path,
    file = join(sessions, "source.jsonl");
  const contents =
    JSON.stringify({ type: "session", id: "original", cwd: root }) +
    "\n" +
    JSON.stringify({
      type: "message",
      message: { role: "user", content: upload },
    }) +
    "\n";
  await writeFile(file, contents);
  await store.registerSession(file);
  await store.releaseConsumed([doc.id], file);
  expect(await store.collectUnreferenced()).toEqual({ reclaimed: [] });
  const registry = join(uploads, RETENTION_REGISTRY);
  return {
    root,
    sessions,
    trash,
    uploads,
    file,
    upload,
    registry,
    contents,
    store,
    open,
  };
}

describe.each(["linux", "darwin", "win32"] as const)(
  "simulated %s namespace continuity across restarts",
  (platform) => {
    it("rejects same-path storage replacement even with unchanged device and mount metadata", async () => {
      const f = await fixture(platform),
        expected = await readFile(f.registry, "utf8");
      await f.store.close();
      await rename(f.sessions, join(f.root, "original-storage"));
      await mkdir(f.sessions);
      await writeFile(f.file, f.contents);
      const reopened = f.open();
      await expect(reopened.registerSession(f.file)).resolves.toBeUndefined();
      expect((await reopened.collectUnreferenced()).deferred).toContain(
        "marker is unavailable",
      );
      expect(await readFile(f.registry, "utf8")).toBe(expected);
      await expect(
        access(join(f.sessions, RETENTION_MARKER)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(f.upload)).resolves.toBeUndefined();
    });
    it("rejects a different valid marker without resetting it during normal registration", async () => {
      const f = await fixture(platform),
        expected = await readFile(f.registry, "utf8");
      await f.store.close();
      await rm(join(f.sessions, RETENTION_MARKER));
      const other = await readRootIdentity(f.sessions, true);
      const reopened = f.open();
      await reopened.registerSession(f.file);
      expect((await reopened.collectUnreferenced()).deferred).toContain(
        "namespace changed",
      );
      expect((await readRootIdentity(f.sessions)).id).toBe(other.id);
      expect(await readFile(f.registry, "utf8")).toBe(expected);
    });
    it("keeps complete directory copies in the same continuity namespace", async () => {
      const f = await fixture(platform),
        expected = await readRootIdentity(f.sessions);
      await f.store.close();
      await rename(f.sessions, join(f.root, "original-storage"));
      await cp(join(f.root, "original-storage"), f.sessions, {
        recursive: true,
      });
      expect((await readRootIdentity(f.sessions)).id).toBe(expected.id);
      const reopened = f.open();
      expect(await reopened.collectUnreferenced()).toEqual({ reclaimed: [] });
      await rm(f.file);
      expect(await reopened.collectUnreferenced()).toEqual({
        reclaimed: [f.upload],
      });
    });
    it("defers a removed registered directory rather than interpreting it as an empty volume", async () => {
      const f = await fixture(platform);
      await f.store.close();
      await rm(f.sessions, { recursive: true });
      expect((await f.open().collectUnreferenced()).deferred).toContain(
        "marker is unavailable",
      );
      await expect(access(f.upload)).resolves.toBeUndefined();
    });
  },
);

describe("retention identity metadata and explicit migration", () => {
  it("keeps Host permissions, process identity and locking native while adapting a different volume protocol", async () => {
    const hostPlatform = process.platform;
    const f = await fixture(hostPlatform === "darwin" ? "win32" : "darwin");
    expect(process.platform).toBe(hostPlatform);
    expect(await f.store.collectUnreferenced()).toEqual({ reclaimed: [] });
  });

  it.each(["truncated", "oversized", "directory", "symlink"] as const)(
    "refuses %s markers without replacement",
    async (kind) => {
      const f = await fixture();
      await f.store.close();
      const marker = join(f.sessions, RETENTION_MARKER);
      await rm(marker);
      if (kind === "directory") await mkdir(marker);
      else if (kind === "symlink") await symlink(f.file, marker);
      else
        await writeFile(marker, kind === "oversized" ? "x".repeat(2048) : "{");
      const reopened = f.open();
      await expect(reopened.registerSession(f.file)).resolves.toBeUndefined();
      expect((await reopened.collectUnreferenced()).deferred).toContain(
        "marker is unavailable or invalid",
      );
      await expect(access(f.upload)).resolves.toBeUndefined();
    },
  );

  it("pins the marker across a complete session/Trash sweep", async () => {
    const f = await fixture(),
      actual = await vi.importActual<
        typeof import("../../server/attachment-references.js")
      >("../../server/attachment-references.js");
    await rm(f.file);
    vi.mocked(sessionAttachmentReferences).mockImplementationOnce(
      async (...args) => {
        const result = await actual.sessionAttachmentReferences(...args);
        await rm(join(f.sessions, RETENTION_MARKER));
        await readRootIdentity(f.sessions, true);
        return result;
      },
    );
    expect((await f.store.collectUnreferenced()).deferred).toContain(
      "storage changed",
    );
    await expect(access(f.upload)).resolves.toBeUndefined();
  });

  it("keeps ordinary registration usable when marker creation fails", async () => {
    const f = await fixture(),
      other = join(f.root, "readonly-or-conflicted");
    await mkdir(other);
    await mkdir(join(other, RETENTION_MARKER));
    await expect(
      f.store.registerSession(join(other, "future.jsonl")),
    ).resolves.toBeUndefined();
    expect((await f.store.collectUnreferenced()).deferred).toContain(
      "Unverified session retention",
    );
    expect(
      JSON.parse(await readFile(f.registry, "utf8")).directories,
    ).toContain(other);
  });

  it("does not change readonly session directory permissions", async (context) => {
    if (process.platform === "win32" || process.getuid?.() === 0)
      return context.skip();
    const f = await fixture(),
      other = join(f.root, "readonly");
    await mkdir(other);
    await chmod(other, 0o500);
    try {
      await expect(
        f.store.registerSession(join(other, "future.jsonl")),
      ).resolves.toBeUndefined();
      expect((await f.store.collectUnreferenced()).deferred).toContain(
        "Unverified session retention",
      );
      await expect(access(join(other, RETENTION_MARKER))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    } finally {
      await chmod(other, 0o700);
    }
  });

  it("previews without writes, rejects active Hosts, then migrates every affected v1/v2 registry offline", async () => {
    const f = await fixture();
    const secondRoot = join(f.root, `1073741822-101-${randomUUID()}`),
      second = f.open(secondRoot);
    await second.ready();
    await second.registerSession(f.file);
    const secondRegistry = join(secondRoot, RETENTION_REGISTRY);
    const unrelated = join(f.root, "old-unverified-root");
    await writeFile(f.registry, JSON.stringify([f.sessions, unrelated]));
    await writeFile(
      secondRegistry,
      JSON.stringify({
        version: 2,
        directories: [f.sessions],
        linuxMounts: {},
      }),
    );
    const before = await readFile(f.registry, "utf8");
    const plan = await trustSessionDirectory(f.sessions, { parent: f.root });
    expect(plan.registries).toHaveLength(2);
    expect(await readFile(f.registry, "utf8")).toBe(before);
    await expect(
      trustSessionDirectory(f.sessions, { parent: f.root, confirm: true }),
    ).rejects.toThrow("Host");
    await f.store.close();
    await second.close();
    await rm(join(f.sessions, RETENTION_MARKER));
    expect(
      (await trustSessionDirectory(f.sessions, { parent: f.root })).marker,
    ).toBeNull();
    await expect(
      access(join(f.sessions, RETENTION_MARKER)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await trustSessionDirectory(f.sessions, { parent: f.root, confirm: true });
    const one = JSON.parse(await readFile(f.registry, "utf8")),
      two = JSON.parse(await readFile(secondRegistry, "utf8"));
    expect(one.version).toBe(3);
    expect(two.version).toBe(3);
    expect(one.directories).toEqual([f.sessions, unrelated]);
    expect(one.identities[f.sessions]).toEqual(two.identities[f.sessions]);
    expect(one.identities[unrelated]).toBeUndefined();
    expect((await f.open().collectUnreferenced()).deferred).toContain(
      "Unverified session retention",
    );
  });

  it("refuses a different valid existing marker even with explicit trust confirmation", async () => {
    const f = await fixture(),
      before = await readFile(f.registry, "utf8");
    await f.store.close();
    await rm(join(f.sessions, RETENTION_MARKER));
    await readRootIdentity(f.sessions, true);
    await expect(
      trustSessionDirectory(f.sessions, { parent: f.root, confirm: true }),
    ).rejects.toThrow("conflicts");
    expect(await readFile(f.registry, "utf8")).toBe(before);
  });

  it("requires stronger replacement consent and never overwrites valid marker or anchor contents", async () => {
    const f = await fixture();
    await f.store.close();
    const before = JSON.parse(await readFile(f.registry, "utf8"));
    await rm(join(f.sessions, RETENTION_MARKER));
    await readRootIdentity(f.sessions, true);
    const anchor = before.identities[f.sessions].volume.directory;
    await rm(join(anchor, RETENTION_MARKER));
    await readRootIdentity(anchor, true);
    const markerBytes = await readFile(
      join(f.sessions, RETENTION_MARKER),
      "utf8",
    );
    const anchorBytes = await readFile(join(anchor, RETENTION_MARKER), "utf8");
    expect(
      (await trustSessionDirectory(f.sessions, { parent: f.root }))
        .requiresReplacement,
    ).toBe(true);
    await expect(
      trustSessionDirectory(f.sessions, { parent: f.root, confirm: true }),
    ).rejects.toThrow("--accept-replacement");
    await trustSessionDirectory(f.sessions, {
      parent: f.root,
      confirm: true,
      acceptReplacement: true,
    });
    expect(await readFile(join(f.sessions, RETENTION_MARKER), "utf8")).toBe(
      markerBytes,
    );
    expect(await readFile(join(anchor, RETENTION_MARKER), "utf8")).toBe(
      anchorBytes,
    );
    await rm(f.file);
    expect(await f.open().collectUnreferenced()).toEqual({
      reclaimed: [f.upload],
    });
  });

  it.each(["darwin", "win32"] as const)(
    "requires complete-storage replacement consent for changed %s native volume proof",
    async (platform) => {
      let current = {
        kind:
          platform === "win32"
            ? ("windows-guid" as const)
            : ("macos-uuid" as const),
        directory: tmpdir(),
        id: randomUUID(),
        ...(platform === "win32" ? { format: "12345678" } : {}),
      };
      const options = {
        parent: tmpdir(),
        platform,
        nativeIdentity: async () => current,
      };
      const f = await fixture(platform, options);
      const markerBytes = await readFile(
        join(f.sessions, RETENTION_MARKER),
        "utf8",
      );
      await f.store.close();
      current = { ...current, id: randomUUID() };
      const reopened = f.open();
      expect((await reopened.collectUnreferenced()).deferred).toContain(
        "volume changed",
      );
      await reopened.close();
      const opts = { parent: f.root, volume: options };
      const preview = await trustDirectory(f.sessions, opts);
      expect(preview.requiresReplacement).toBe(true);
      await expect(
        trustDirectory(f.sessions, { ...opts, confirm: true }),
      ).rejects.toThrow("--accept-replacement");
      await trustDirectory(f.sessions, {
        ...opts,
        confirm: true,
        acceptReplacement: true,
      });
      expect(await readFile(join(f.sessions, RETENTION_MARKER), "utf8")).toBe(
        markerBytes,
      );
      const resumed = f.open();
      expect(await resumed.collectUnreferenced()).toEqual({ reclaimed: [] });
      await rm(f.file);
      expect(await resumed.collectUnreferenced()).toEqual({
        reclaimed: [f.upload],
      });
    },
  );

  it("defers marker loss until explicit offline trust, then resumes ordinary collection after restart", async () => {
    const f = await fixture();
    await rm(f.file);
    await rm(join(f.sessions, RETENTION_MARKER));
    await f.store.close();
    const deferred = f.open();
    expect((await deferred.collectUnreferenced()).deferred).toContain(
      "marker is unavailable",
    );
    await deferred.close();
    await trustSessionDirectory(f.sessions, { parent: f.root, confirm: true });
    expect(await f.open().collectUnreferenced()).toEqual({
      reclaimed: [f.upload],
    });
  });

  it("blocks trust while another Host sharing the parent has no registry yet", async () => {
    const f = await fixture();
    await f.store.close();
    const reader = f.open(join(f.root, `1073741822-102-${randomUUID()}`));
    await reader.ready();
    await expect(
      trustSessionDirectory(f.sessions, { parent: f.root, confirm: true }),
    ).rejects.toThrow("Stop every");
  });

  it("does not authorize a legacy sibling registry through another Host's v3 identity", async () => {
    const f = await fixture();
    await f.store.close();
    const legacyRoot = join(f.root, `1073741822-102-${randomUUID()}`);
    await mkdir(legacyRoot);
    await writeFile(
      join(legacyRoot, RETENTION_REGISTRY),
      JSON.stringify([f.sessions]),
    );
    const reader = f.open(
      join(f.root, `1073741821-103-${randomUUID()}`),
      f.root,
    );
    expect((await reader.collectUnreferenced()).deferred).toContain(
      "Unverified session retention",
    );
    await expect(access(f.upload)).resolves.toBeUndefined();
  });

  it("requires the shared maintenance gate for new Host startup and trust", async () => {
    const f = await fixture();
    await f.store.close();
    await withRetentionMaintenance(f.root, async () => {
      await expect(
        trustSessionDirectory(f.sessions, { parent: f.root, confirm: true }),
      ).rejects.toMatchObject({ code: "ELOCKTIMEOUT" });
    });
    await trustSessionDirectory(f.sessions, { parent: f.root, confirm: true });
  });

  it.each(["native", ...(process.platform === "linux" ? ["portable"] : [])])(
    "recovers the maintenance gate after a crashed %s lock holder",
    async (protocol) => {
      const f = await fixture();
      await f.store.close();
      const lockParent = join(f.root, "crashed-gate");
      await mkdir(lockParent);
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("tests/fixtures/attachment-retention-lock.ts"),
          lockParent,
          protocol,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const closed = new Promise<void>((resolveClosed) =>
        child.once("close", () => resolveClosed()),
      );
      try {
        await new Promise<void>((ready, reject) => {
          child.stdout.once("data", () => ready());
          child.once("error", reject);
          child.once("exit", (code) =>
            reject(new Error("Lock fixture exited before ready: " + code)),
          );
        });
        child.kill("SIGKILL");
        await closed;
        if (protocol === "portable")
          vi.stubGlobal(
            "process",
            new Proxy(process, {
              get: (target, key) =>
                key === "platform" ? "darwin" : Reflect.get(target, key),
            }),
          );
        await expect(
          withRetentionMaintenance(lockParent, async () => "recovered", true),
        ).resolves.toBe("recovered");
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await closed;
      }
    },
  );

  it("does not let PID reuse turn a dead birth-bound lease/upload owner into a live Host", async () => {
    const f = await fixture();
    await f.store.close();
    const lease = join(
      f.uploads,
      ".inspire-retention-active-" + process.pid + "-" + randomUUID(),
    );
    await writeFile(
      lease,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        processStartTime: "different-process-birth",
      }),
    );
    const ownershipPath = join(
      f.uploads,
      (await readdir(f.uploads)).find((name) =>
        /^[0-9a-f-]{36}\.json$/u.test(name),
      )!,
    );
    const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
    await writeFile(
      ownershipPath,
      JSON.stringify({
        ...ownership,
        ownerPid: process.pid,
        ownerStartTime: "different-process-birth",
      }),
    );
    await expect(
      trustSessionDirectory(f.sessions, { parent: f.root, confirm: true }),
    ).resolves.toBeDefined();
  });

  it("keeps an unknown legacy lease PID conservative instead of guessing its process birth", async () => {
    const f = await fixture();
    await f.store.close();
    await writeFile(
      join(
        f.uploads,
        ".inspire-retention-active-" + process.pid + "-" + randomUUID(),
      ),
      "",
    );
    await expect(
      trustSessionDirectory(f.sessions, { parent: f.root, confirm: true }),
    ).rejects.toThrow("Stop every");
  });

  it("persists only actual discovered session references, never catalog path existence", async () => {
    const f = await fixture(),
      external = join(f.root, "external");
    await mkdir(external);
    f.store.discoverSessionDirectories(async () => [external]);
    expect(await f.store.collectUnreferenced()).toEqual({ reclaimed: [] });
    await expect(
      access(join(external, RETENTION_MARKER)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(external, "fork.jsonl"), f.contents);
    expect(await f.store.collectUnreferenced()).toEqual({ reclaimed: [] });
    expect((await readRootIdentity(external)).id).toBeTruthy();
    await f.store.close();
    await rename(external, join(f.root, "offline-external"));
    await mkdir(external);
    expect((await f.open().collectUnreferenced()).deferred).toContain(
      "marker is unavailable",
    );
  });
});
