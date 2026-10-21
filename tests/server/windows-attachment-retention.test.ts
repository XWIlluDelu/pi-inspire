import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionAttachmentReferences } from "../../server/attachment-references.js";
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
const roots: string[] = [];
const stores: AttachmentStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-windows-retention-")),
  );
  roots.push(root);
  const sessions = join(root, "sessions");
  await mkdir(sessions);
  const store = new AttachmentStore(join(root, "uploads"), null, {
    sessionDirectories: [sessions, join(root, "never-used")],
    trashDirectories: [join(root, "Trash")],
    sweepIntervalMs: 0,
    volume: {
      platform: "win32",
      nativeIdentity: async () => ({
        kind: "windows-guid",
        directory: root,
        id: "12345678-1234-4234-8234-123456789abc",
        format: "12345678",
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
  const file = join(sessions, "session.jsonl");
  await writeFile(
    file,
    JSON.stringify({ type: "session", id: "source", cwd: root }) + "\n",
  );
  await store.registerSession(file);
  await store.releaseConsumed([doc.id], file);
  await rm(file);
  return { root, sessions, file, store, upload: files[0]!.path };
}

describe("Windows registered session-root retention", () => {
  it("defers reclamation when registered storage is missing instead of treating an offline drive as empty", async () => {
    const { sessions, store, file, upload } = await fixture();
    await rm(sessions, { recursive: true });
    const result = await store.sessionDeleted(file);
    expect(result.reclaimed).toEqual([]);
    expect(result.deferred).toBeTruthy();
    await expect(access(upload)).resolves.toBeUndefined();
  });

  it("allows a never-used missing root without disabling ordinary reclamation", async () => {
    const { store, file, upload } = await fixture();
    expect(await store.sessionDeleted(file)).toEqual({ reclaimed: [upload] });
  });

  it("rejects a replaced session directory after the reference scan", async () => {
    const { root, sessions, store, file, upload } = await fixture();
    const original = await vi.importActual<
      typeof import("../../server/attachment-references.js")
    >("../../server/attachment-references.js");
    vi.mocked(sessionAttachmentReferences).mockImplementationOnce(
      async (...args) => {
        const result = await original.sessionAttachmentReferences(...args);
        await rename(sessions, join(root, "old-sessions"));
        await mkdir(sessions);
        return result;
      },
    );
    expect(await store.sessionDeleted(file)).toMatchObject({
      reclaimed: [],
      deferred: expect.stringContaining("storage changed"),
    });
    await expect(access(upload)).resolves.toBeUndefined();
  });
});
