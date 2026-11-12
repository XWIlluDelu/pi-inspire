import {
  lstat,
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
import {
  RECOVERY_MANIFEST,
  RECOVERY_README,
} from "../../server/session-recovery.js";

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

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-native-trash-command-")),
  );
  roots.push(root);
  const bundle = join(root, "private recovery ' ; $ folder");
  await mkdir(bundle);
  const original = join(root, "original sessions", "session.jsonl");
  await mkdir(join(root, "original sessions"));
  const payload = join(bundle, "session.jsonl");
  const contents =
    JSON.stringify({ type: "session", id: "session-a", cwd: root }) + "\n";
  await writeFile(payload, contents);
  return { root, bundle, original, payload, contents };
}

afterEach(async () => {
  native.run.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("native Trash command boundaries", () => {
  it.each([
    { platform: "darwin", key: "SystemRoot" },
    { platform: "win32", key: "programfiles" },
  ] as const)(
    "sends only the private bundle through $platform native API ($key)",
    async ({ platform, key }) => {
      const { root, bundle, original, payload, contents } = await fixture();
      const moved = join(root, "isolated trash result");
      const before = await lstat(payload);

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
          expect(manifest).toMatchObject({
            format: "inspire-session-recovery",
            version: 1,
            originalPath: original,
            payload: "session.jsonl",
            sessionId: "session-a",
            cwd: root,
          });
          const readme = await readFile(join(bundle, RECOVERY_README), "utf8");
          expect(readme).toContain(original);
          expect(readme).toContain('inspire recover-session "<bundle-folder>"');
          expect(readme).toMatch(
            /node \x27.*inspire\.mjs\x27 recover-session/u,
          );
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
      const movedPayload = join(moved, "session.jsonl");
      const after = await lstat(movedPayload);
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      expect(await readFile(movedPayload, "utf8")).toBe(contents);
    },
  );

  it("rejects a native success that leaves the recovery bundle in place", async () => {
    const { root, bundle, original, payload, contents } = await fixture();
    await expect(
      moveToDesktopTrash(payload, original, {
        platform: "darwin",
        home: root,
      }),
    ).rejects.toThrow("did not consume");
    expect(native.run).toHaveBeenCalledOnce();
    expect(await readFile(payload, "utf8")).toBe(contents);
    expect(
      JSON.parse(await readFile(join(bundle, RECOVERY_MANIFEST), "utf8"))
        .originalPath,
    ).toBe(original);
  });
});
