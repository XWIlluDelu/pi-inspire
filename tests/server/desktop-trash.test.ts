import {
  mkdir,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moveToDesktopTrash } from "../../server/desktop-trash.js";

const roots: string[] = [];

async function fixture(name = "session-a.jsonl") {
  const root = await mkdtemp(join(tmpdir(), "inspire-desktop-trash-"));
  roots.push(root);
  const payload = join(root, "private", name);
  await mkdir(join(root, "private"));
  await writeFile(payload, "session bytes\n");
  return { root, payload, original: join(root, "sessions", name) };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("desktop Trash adapters", () => {
  it("writes a Freedesktop payload and restore record on Linux", async () => {
    const { root, payload, original } = await fixture();
    const dataHome = join(root, "data");

    const before = await lstat(payload);
    await moveToDesktopTrash(payload, original, {
      platform: "linux",
      environment: { XDG_DATA_HOME: dataHome },
      home: join(root, "home"),
    });

    await expect(readFile(payload)).rejects.toMatchObject({ code: "ENOENT" });
    const payloads = await readdir(join(dataHome, "Trash", "files"));
    const moved = await lstat(join(dataHome, "Trash", "files", payloads[0]!));
    expect({ dev: moved.dev, ino: moved.ino }).toEqual({
      dev: before.dev,
      ino: before.ino,
    });
    expect(payloads).toHaveLength(1);
    expect(
      await readFile(join(dataHome, "Trash", "files", payloads[0]!), "utf8"),
    ).toBe("session bytes\n");
    const metadata = await readFile(
      join(dataHome, "Trash", "info", `${payloads[0]}.trashinfo`),
      "utf8",
    );
    const encodedOriginal = encodeURIComponent(original).replaceAll("%2F", "/");
    expect(metadata).toContain(`Path=${encodedOriginal}\n`);
  });

  it("moves the exact payload into the macOS user Trash", async () => {
    const { root, payload, original } = await fixture();
    const home = join(root, "home");

    await moveToDesktopTrash(payload, original, {
      platform: "darwin",
      environment: {},
      home,
    });

    await expect(readFile(payload)).rejects.toMatchObject({ code: "ENOENT" });
    const entries = await readdir(join(home, ".Trash"));
    expect(entries).toHaveLength(1);
    expect(await readFile(join(home, ".Trash", entries[0]!), "utf8")).toBe(
      "session bytes\n",
    );
  });

  it("requires the Windows Recycle Bin consumer to remove the payload", async () => {
    const { payload, original } = await fixture();
    const consumed: string[] = [];

    await moveToDesktopTrash(payload, original, {
      platform: "win32",
      environment: {},
      home: "C:\\Users\\tester",
      windowsRecycle: async (path) => {
        consumed.push(path);
        await rm(path);
      },
    });

    expect(consumed).toEqual([payload]);
    await expect(readFile(payload)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails when a Windows Recycle Bin consumer leaves the file behind", async () => {
    const { payload, original } = await fixture();
    await expect(
      moveToDesktopTrash(payload, original, {
        platform: "win32",
        environment: {},
        home: "C:\\Users\\tester",
        windowsRecycle: async () => undefined,
      }),
    ).rejects.toThrow("did not consume");
    await expect(readFile(payload, "utf8")).resolves.toBe("session bytes\n");
  });
});
