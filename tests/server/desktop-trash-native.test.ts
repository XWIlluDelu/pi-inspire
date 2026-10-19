import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moveToDesktopTrash } from "../../server/desktop-trash.js";
import { macosSessionTrashDirectories } from "../../server/macos-trash.js";
import { RECOVERY_MANIFEST } from "../../server/session-recovery.js";

const native = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: async (
      ...args: unknown[]
    ) => ({
      stdout: (await native.run(...args)) ?? "",
      stderr: "",
    }),
  }),
}));
const roots: string[] = [];

afterEach(async () => {
  native.run.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("native Trash command boundaries", () => {
  it("asks Foundation for exact known-session volume URLs without interpolating paths", async () => {
    const root = join(tmpdir(), "inspire-native-volume-layout");
    const home = join(root, "home");
    const sessions = join(root, "external", "sessions");
    const homeVolume = join(root, "data");
    const externalVolume = join(root, "external");
    native.run.mockImplementation(async (command: string, args: string[]) => {
      expect(command).toBe("/usr/bin/osascript");
      expect(args[3]).toContain("NSURLVolumeURLKey");
      expect(args[3]).toContain("getResourceValueForKeyError");
      expect(args[3]).not.toContain(sessions);
      expect(args.slice(4)).toEqual([home, sessions]);
      return JSON.stringify([homeVolume, externalVolume]);
    });
    await expect(
      macosSessionTrashDirectories([sessions], { home, uid: 501 }),
    ).resolves.toEqual([
      join(home, ".Trash"),
      join(externalVolume, ".Trashes", "501"),
    ]);
  });

  it.each([
    { platform: "darwin", key: "SystemRoot" },
    { platform: "win32", key: "ProgramFiles" },
    { platform: "win32", key: "programfiles" },
    { platform: "win32", key: "PROGRAMFILES" },
  ] as const)(
    "sends only the private bundle through $platform native API ($key)",
    async ({ platform, key }) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "inspire-native-trash-command-")),
      );
      roots.push(root);
      const bundle = join(root, "private recovery ' ; $ folder");
      await mkdir(bundle);
      const original = join(root, "original sessions", "session.jsonl");
      await mkdir(join(root, "original sessions"));
      const payload = join(bundle, "session.jsonl");
      await writeFile(
        payload,
        JSON.stringify({ type: "session", id: "session-a", cwd: root }) + "\n",
      );
      const moved = join(root, "isolated trash result");

      native.run.mockImplementation(
        async (
          command: string,
          args: string[],
          options: { env?: NodeJS.ProcessEnv; timeout: number },
        ) => {
          expect(options.timeout).toBe(10_000);
          const manifest = JSON.parse(
            await readFile(join(bundle, RECOVERY_MANIFEST), "utf8"),
          );
          expect(manifest.originalPath).toBe(original);
          if (platform === "win32") {
            expect(command).toBe("D:\\Program Files\\PowerShell\\7\\pwsh.exe");
            expect(options.env?.INSPIRE_TRASH_PATH).toBe(bundle);
            expect(args.at(-1)).toContain(
              "::DeleteDirectory($env:INSPIRE_TRASH_PATH,",
            );
            expect(args.at(-1)).toContain("::SendToRecycleBin");
            expect(args.join(" ")).not.toContain(bundle);
          } else {
            expect(command).toBe("/usr/bin/osascript");
            expect(args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
            expect(args[3]).toContain("trashItemAtURLResultingItemURLError");
            expect(args[3]).toContain("fileURLWithPath(argv[0])");
            expect(args[3]).not.toContain(bundle);
            expect(args.at(-1)).toBe(bundle);
          }
          expect(args.join(" ")).not.toContain(original);
          await rename(bundle, moved);
        },
      );

      await expect(
        moveToDesktopTrash(payload, original, {
          platform,
          environment: { [key]: "D:\\Program Files" },
          home: root,
        }),
      ).resolves.toBeUndefined();
      expect(native.run).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(await readFile(join(moved, RECOVERY_MANIFEST), "utf8"))
          .originalPath,
      ).toBe(original);
    },
  );
});
