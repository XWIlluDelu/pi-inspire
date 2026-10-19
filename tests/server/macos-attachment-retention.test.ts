import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { macosSessionTrashDirectories } from "../../server/macos-trash.js";

vi.mock("../../server/macos-trash.js", () => ({
  macosSessionTrashDirectories: vi.fn(),
}));
const roots: string[] = [];
const stores: AttachmentStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
describe("macOS optional session-root retention", () => {
  it("does not pass an unused missing default root to native Foundation volume lookup", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "inspire-macos-retention-")),
    );
    roots.push(root);
    const sessions = join(root, "actual-sessions");
    const unused = join(root, "never-used-default");
    const trash = join(root, "Trash", "files");
    await mkdir(sessions);
    vi.mocked(macosSessionTrashDirectories).mockImplementation(
      async (directories) => {
        expect(directories).toEqual([sessions]);
        return [trash];
      },
    );
    const store = new AttachmentStore(join(root, "uploads"), null, {
      sessionDirectories: [sessions, unused],
      sweepIntervalMs: 0,
      volume: {
        platform: "darwin",
        nativeIdentity: async () => ({
          kind: "macos-uuid",
          directory: root,
          id: "12345678-1234-4234-8234-123456789abc",
        }),
      },
    });
    stores.push(store);
    const doc = await store.add({
      originalname: "notes.txt",
      mimetype: "text/plain",
      size: 5,
      buffer: Buffer.from("hello"),
    } as Express.Multer.File);
    const { files } = await store.resolveForPrompt([doc.id]);
    const path = files[0]!.path;
    const file = join(sessions, "actual.jsonl");
    await writeFile(
      file,
      JSON.stringify({ type: "session", id: "actual", cwd: root }) + "\n",
    );
    await store.registerSession(file);
    await store.releaseConsumed([doc.id], file);
    await rm(file);
    expect(await store.sessionDeleted(file)).toEqual({ reclaimed: [path] });
    await expect(access(unused)).rejects.toMatchObject({ code: "ENOENT" });
    expect(macosSessionTrashDirectories).toHaveBeenCalledOnce();
  });
});
