import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moveToDesktopTrash } from "../../server/desktop-trash.js";
import {
  RECOVERY_MANIFEST,
  RECOVERY_README,
} from "../../server/session-recovery.js";

const roots: string[] = [];

async function fixture(name = "session-a.jsonl") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-desktop-trash-")),
  );
  roots.push(root);
  const payload = join(root, "private", "Inspire session recovery", name);
  await mkdir(dirname(payload), { recursive: true });
  await mkdir(join(root, "sessions"));
  const content = `${JSON.stringify({ type: "session", id: "session-a", cwd: root })}\nsession bytes\n`;
  await writeFile(payload, content);
  return { root, payload, original: join(root, "sessions", name), content };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("desktop Trash adapters", () => {
  it("writes a Freedesktop payload and original-path restore record on Linux", async () => {
    const { root, payload, original, content } = await fixture(
      "session 空格 #%.jsonl",
    );
    const dataHome = join(root, "data");

    const before = await lstat(payload);
    await moveToDesktopTrash(payload, original, {
      platform: "linux",
      environment: { XDG_DATA_HOME: dataHome },
      home: join(root, "home"),
      linux: {
        uid: before.uid,
        mounts: async () => [
          {
            id: 1,
            root,
            mountPoint: root,
            filesystem: "fixture",
            source: "fixture",
          },
        ],
      },
    });

    await expect(readFile(payload)).rejects.toMatchObject({ code: "ENOENT" });
    const payloads = await readdir(join(dataHome, "Trash", "files"));
    expect(payloads).toHaveLength(1);
    const destination = join(dataHome, "Trash", "files", payloads[0]!);
    const moved = await lstat(destination);
    expect({ dev: moved.dev, ino: moved.ino }).toEqual({
      dev: before.dev,
      ino: before.ino,
    });
    expect(await readFile(destination, "utf8")).toBe(content);
    const metadata = await readFile(
      join(dataHome, "Trash", "info", `${payloads[0]}.trashinfo`),
      "utf8",
    );
    expect(metadata).toContain(
      `Path=${encodeURIComponent(original).replaceAll("%2F", "/")}\n`,
    );
  });

  it.each(["darwin", "win32"] as const)(
    "gives %s only a complete private recovery bundle, never the public pathname",
    async (platform) => {
      const { root, payload, original, content } = await fixture();
      const destination = join(root, "isolated-native-trash");
      let consumed = "";
      const recycle = async (directory: string) => {
        consumed = directory;
        expect(directory).toBe(dirname(payload));
        expect(directory).not.toBe(dirname(original));
        const manifest = JSON.parse(
          await readFile(join(directory, RECOVERY_MANIFEST), "utf8"),
        );
        expect(manifest).toMatchObject({
          format: "inspire-session-recovery",
          version: 1,
          originalPath: original,
          payload: "session-a.jsonl",
          sessionId: "session-a",
          cwd: root,
        });
        const readme = await readFile(join(directory, RECOVERY_README), "utf8");
        expect(readme).toContain(original);
        expect(readme).toContain('inspire recover-session "<bundle-folder>"');
        expect(readme).toMatch(/node \x27.*inspire\.mjs\x27 recover-session/u);
        await rename(directory, destination);
      };
      const before = await lstat(payload);
      await moveToDesktopTrash(payload, original, {
        platform,
        environment: {},
        home: root,
        windowsRecycle: recycle,
        macosRecycle: recycle,
      });

      expect(consumed).toBe(dirname(payload));
      await expect(readFile(payload)).rejects.toMatchObject({ code: "ENOENT" });
      const moved = await lstat(join(destination, "session-a.jsonl"));
      expect({ dev: moved.dev, ino: moved.ino }).toEqual({
        dev: before.dev,
        ino: before.ino,
      });
      expect(await readFile(join(destination, "session-a.jsonl"), "utf8")).toBe(
        content,
      );
    },
  );

  it.each(["darwin", "win32"] as const)(
    "rejects a false %s success and retains a self-contained private bundle",
    async (platform) => {
      const { root, payload, original, content } = await fixture();
      await expect(
        moveToDesktopTrash(payload, original, {
          platform,
          environment: {},
          home: root,
          windowsRecycle: async () => undefined,
          macosRecycle: async () => undefined,
        }),
      ).rejects.toThrow("did not consume");
      expect(await readFile(payload, "utf8")).toBe(content);
      expect(
        JSON.parse(
          await readFile(join(dirname(payload), RECOVERY_MANIFEST), "utf8"),
        ).originalPath,
      ).toBe(original);
    },
  );
});
