import { execFile as execFileCallback } from "node:child_process";
import {
  appendFile,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareSessionRecovery,
  RECOVERY_MANIFEST,
  RECOVERY_README,
  recoverSessionBundle,
} from "../../server/session-recovery.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link), open: vi.fn(actual.open) };
});

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "inspire-session-recovery-"),
  );
  roots.push(root);
  const directory = join(root, "original sessions");
  const bundle = join(root, "restored recovery bundle");
  await mkdir(directory);
  await mkdir(bundle);
  const original = join(directory, "session 空格 #%.jsonl");
  const payload = join(bundle, basename(original));
  const contents =
    `${JSON.stringify({ type: "session", id: "session-a", cwd: root })}\n` +
    '{"type":"message","text":"Original conversation"}\n';
  await writeFile(payload, contents);
  await prepareSessionRecovery(payload, original);
  return { root, bundle, original, payload, contents };
}

afterEach(async () => {
  vi.mocked(open).mockRestore();
  vi.mocked(link).mockRestore();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("explicit original-path session recovery", () => {
  it("provides a standalone recovery command without starting a Host", async () => {
    const { bundle, original, contents } = await fixture();
    const entry = fileURLToPath(
      new URL("../../server/session-recovery-entry.ts", import.meta.url),
    );
    const execFile = promisify(execFileCallback);
    const command = [
      process.execPath,
      ["--import", "tsx", entry, bundle],
    ] as const;
    const { stdout } = await execFile(command[0], [...command[1]], {
      cwd: process.cwd(),
    });
    expect(stdout).toContain("Recovered session: " + original);
    expect(stdout).toContain("Recovery bundle retained.");
    expect(await readFile(original, "utf8")).toBe(contents);
    await expect(
      execFile(command[0], [...command[1]], { cwd: process.cwd() }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("already exists"),
    });
  });

  it("restores complete bytes atomically and leaves the complete selected bundle intact", async () => {
    const { bundle, original, payload, contents } = await fixture();
    await expect(recoverSessionBundle(bundle)).resolves.toBe(original);
    expect(await readFile(original, "utf8")).toBe(contents);
    expect(await readFile(payload, "utf8")).toBe(contents);
    expect((await readdir(bundle)).sort()).toEqual(
      [RECOVERY_MANIFEST, RECOVERY_README, basename(payload)].sort(),
    );
    expect(await readdir(dirname(original))).toEqual([basename(original)]);
    expect((await lstat(original)).ino).not.toBe((await lstat(payload)).ino);
    await expect(recoverSessionBundle(bundle)).rejects.toThrow(
      "already exists",
    );
  });

  it("accepts a copied/restored bundle whose payload inode changed", async () => {
    const { root, bundle, original, payload, contents } = await fixture();
    const copy = join(root, "another volume copy");
    await cp(bundle, copy, { recursive: true });
    expect((await lstat(join(copy, basename(payload)))).ino).not.toBe(
      (await lstat(payload)).ino,
    );
    await expect(recoverSessionBundle(copy)).resolves.toBe(original);
    expect(await readFile(original, "utf8")).toBe(contents);
  });

  it.runIf(process.platform === "linux")(
    "recovers a bundle across real filesystem devices without an EXDEV publication",
    async ({ skip }) => {
      const { bundle, original, contents } = await fixture();
      const otherVolume = await lstat("/dev/shm").catch(() => undefined);
      if (!otherVolume || otherVolume.dev === (await lstat(bundle)).dev) {
        skip();
        return;
      }
      const otherRoot = await mkdtemp("/dev/shm/inspire-session-recovery-");
      roots.push(otherRoot);
      const copiedBundle = join(otherRoot, "restored bundle");
      await cp(bundle, copiedBundle, { recursive: true });
      expect((await lstat(copiedBundle)).dev).not.toBe(
        (await lstat(dirname(original))).dev,
      );
      await expect(recoverSessionBundle(copiedBundle)).resolves.toBe(original);
      expect(await readFile(original, "utf8")).toBe(contents);
    },
  );

  it("records a physical original parent before a configured alias can be retargeted", async () => {
    const { root, original, payload, bundle, contents } = await fixture();
    const alias = join(root, "configured sessions alias");
    const other = join(root, "different sessions");
    await mkdir(other);
    await symlink(
      dirname(original),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    // Recreate the initial bundle metadata using the configured directory alias.
    await rm(join(bundle, RECOVERY_MANIFEST));
    await rm(join(bundle, RECOVERY_README));
    await prepareSessionRecovery(payload, join(alias, basename(original)));
    await rm(alias);
    await symlink(
      other,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(recoverSessionBundle(bundle)).resolves.toBe(original);
    expect(await readFile(original, "utf8")).toBe(contents);
    expect(await readdir(other)).toEqual([]);
  });

  it("preserves a newer existing session and every recovery file", async () => {
    const { bundle, original, payload, contents } = await fixture();
    await writeFile(original, "newer session\n");
    await expect(recoverSessionBundle(bundle)).rejects.toThrow(
      "already exists",
    );
    expect(await readFile(original, "utf8")).toBe("newer session\n");
    expect(await readFile(payload, "utf8")).toBe(contents);
  });

  it("does not overwrite a destination created after copying but before publication", async () => {
    const { bundle, original } = await fixture();
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(link).mockImplementationOnce(async (from, to) => {
      await writeFile(original, "concurrent Pi session\n");
      return actual.link(from, to);
    });
    await expect(recoverSessionBundle(bundle)).rejects.toThrow(
      "already exists",
    );
    expect(await readFile(original, "utf8")).toBe("concurrent Pi session\n");
    expect(await readdir(dirname(original))).toEqual([basename(original)]);
  });

  it.each([
    "../escaped.jsonl",
    "subdir/session.jsonl",
    "subdir\\session.jsonl",
    "/absolute.jsonl",
  ])(
    "rejects manifest traversal %s without creating a destination",
    async (payload) => {
      const { bundle, original } = await fixture();
      const path = join(bundle, RECOVERY_MANIFEST);
      const manifest = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...manifest, payload }));
      await expect(recoverSessionBundle(bundle)).rejects.toThrow(
        "Invalid session recovery manifest",
      );
      await expect(lstat(original)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects an original-path manifest containing parent traversal", async () => {
    const { bundle, original } = await fixture();
    const path = join(bundle, RECOVERY_MANIFEST);
    const manifest = JSON.parse(await readFile(path, "utf8"));
    const separator = sep;
    const noncanonical =
      dirname(original) +
      separator +
      "unused" +
      separator +
      ".." +
      separator +
      basename(original);
    await writeFile(
      path,
      JSON.stringify({ ...manifest, originalPath: noncanonical }),
    );
    await expect(recoverSessionBundle(bundle)).rejects.toThrow(
      "Invalid session recovery manifest",
    );
    await expect(lstat(original)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects replaced bytes even when the valid Pi header and length are unchanged", async () => {
    const { bundle, original, payload, contents } = await fixture();
    await rename(payload, join(bundle, "retained-original"));
    await writeFile(
      payload,
      contents.replace("Original conversation", "Replaced conversation"),
    );
    await expect(recoverSessionBundle(bundle)).rejects.toThrow(
      "bytes do not match",
    );
    await expect(lstat(original)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(dirname(original))).toEqual([]);
  });

  it("rejects a payload changed during a pinned copy and leaves both versions private", async () => {
    const { bundle, original, payload, contents } = await fixture();
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(open).mockImplementation(
      async (...args: Parameters<typeof open>) => {
        if (args[1] === "wx" && basename(String(args[0])) === "payload")
          await appendFile(payload, "late write\n");
        return actual.open(...args);
      },
    );
    await expect(recoverSessionBundle(bundle)).rejects.toThrow("changed");
    await expect(lstat(original)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(payload, "utf8")).toBe(contents + "late write\n");
    expect(await readdir(dirname(original))).toEqual([]);
  });

  it("rejects a source-path replacement during copying, even with identical bytes", async () => {
    const { bundle, original, payload, contents } = await fixture();
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(open).mockImplementation(
      async (...args: Parameters<typeof open>) => {
        if (args[1] === "wx" && basename(String(args[0])) === "payload") {
          await rename(payload, join(bundle, "retained-original"));
          await writeFile(payload, contents);
        }
        return actual.open(...args);
      },
    );
    await expect(recoverSessionBundle(bundle)).rejects.toThrow("changed");
    await expect(lstat(original)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it
    .runIf(process.platform !== "win32")
    .each(["payload", "manifest", "bundle", "destination", "parent"] as const)(
    "refuses a symlinked %s",
    async (kind) => {
      const f = await fixture();
      let selected = f.bundle;
      if (kind === "payload" || kind === "manifest") {
        const path =
          kind === "payload" ? f.payload : join(f.bundle, RECOVERY_MANIFEST);
        await rename(path, path + ".real");
        await symlink(path + ".real", path);
      } else if (kind === "bundle") {
        selected += ".link";
        await symlink(f.bundle, selected);
      } else if (kind === "destination") {
        await symlink(f.payload, f.original);
      } else {
        const parent = dirname(f.original);
        await rename(parent, parent + ".real");
        await symlink(parent + ".real", parent);
      }
      await expect(recoverSessionBundle(selected)).rejects.toThrow(
        /symlink|already exists/u,
      );
      expect(await readFile(f.payload, "utf8")).toBe(f.contents);
    },
  );

  it("preserves the bundle if the original storage directory is missing", async () => {
    const { bundle, original, payload, contents } = await fixture();
    await rm(dirname(original), { recursive: true });
    await expect(recoverSessionBundle(bundle)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(payload, "utf8")).toBe(contents);
    await expect(lstat(dirname(original))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
