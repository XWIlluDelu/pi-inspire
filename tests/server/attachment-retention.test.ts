import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import type { UploadedAttachment } from "../../shared/contracts.js";

const roots: string[] = [];
const stores: AttachmentStore[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) await stop(child);
  for (const store of stores.splice(0)) await store.close().catch(() => {});
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
async function fixture() {
  // Match the canonical paths persisted by AttachmentStore, including aliased
  // macOS temporary directories and Windows short path spellings.
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-attachment-lifecycle-")),
  );
  roots.push(parent);
  const root = join(parent, "1-1-current");
  const store = new AttachmentStore(root, parent, { sweepIntervalMs: 0 });
  stores.push(store);
  await store.ready();
  return { parent, root, store };
}
function upload(): Express.Multer.File {
  return {
    originalname: "notes.txt",
    mimetype: "text/plain",
    buffer: Buffer.from("notes"),
    size: 5,
  } as Express.Multer.File;
}
async function owner(parent: string, mode: "staged" | "prepared") {
  const root = join(parent, "2-2-child");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL("../fixtures/attachment-lifecycle.ts", import.meta.url),
      ),
      root,
      mode,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  const uploads = await new Promise<UploadedAttachment[]>((resolve, reject) => {
    let output = "",
      errors = "";
    child.stderr!.on("data", (data) => {
      errors += data;
    });
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error(errors || "Attachment owner exited before ready")),
    );
    child.stdout!.on("data", (data) => {
      output += data;
      if (output.includes("\n")) {
        try {
          resolve(JSON.parse(output.slice(0, output.indexOf("\n"))));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  const records = await Promise.all(
    uploads.map(async (upload) =>
      JSON.parse(await readFile(join(root, upload.id + ".json"), "utf8")),
    ),
  );
  return { child, records, root };
}

describe("temporary uploads and durable delivered assets", () => {
  it("reclaims abandoned staging only after its real owner exits, across shared Hosts", async () => {
    const { parent, store } = await fixture();
    const f = await owner(parent, "staged");
    expect(await store.collectStaged()).toEqual({ reclaimed: [] });
    await stop(f.child);
    expect((await store.collectStaged()).reclaimed.sort()).toEqual(
      f.records.map((record) => record.path).sort(),
    );
    for (const record of f.records) {
      await expect(access(record.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        access(join(f.root, record.id + ".json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("preserves a possible delivery after an owner crash, without requiring a visible session reference", async () => {
    const { parent, store } = await fixture();
    const f = await owner(parent, "prepared");
    expect(f.records.map((record) => record.delivery)).toEqual([
      "possible",
      "possible",
    ]);
    await stop(f.child);
    expect(await store.collectStaged()).toEqual({ reclaimed: [] });
    for (const record of f.records)
      await expect(access(record.path)).resolves.toBeUndefined();
    expect(store.ownsPromptFile(f.records[0].path)).toBe(true);
    expect(store.ownsPromptFile(f.records[1].path)).toBe(false);
  });

  it.each([undefined, 2])(
    "keeps existing version %s assets recallable and unchanged",
    async (version) => {
      const { parent, store } = await fixture();
      const root = join(parent, "3-3-existing");
      await mkdir(root);
      const id = randomUUID(),
        path = join(root, id + "-legacy.txt");
      const record = {
        version,
        id,
        fileName: "legacy.txt",
        mimeType: "text/plain",
        kind: "file",
        size: 4,
        path,
        ownerPid: 0,
      };
      const metadata = JSON.stringify(record);
      await writeFile(path, "keep");
      await writeFile(join(root, id + ".json"), metadata);
      expect(await store.collectStaged()).toEqual({ reclaimed: [] });
      expect(store.promptFileName(path)).toBe("legacy.txt");
      expect(await readFile(path, "utf8")).toBe("keep");
      expect(await readFile(join(root, id + ".json"), "utf8")).toBe(metadata);
    },
  );

  it("removes withdrawn staging but preserves a file handed off before shutdown", async () => {
    const { root, store } = await fixture();
    const abandoned = await store.add(upload());
    const delivered = await store.add(upload());
    const { files } = await store.resolveForPrompt([delivered.id]);
    expect(
      JSON.parse(await readFile(join(root, delivered.id + ".json"), "utf8"))
        .delivery,
    ).toBe("possible");
    await store.releaseConsumed([delivered.id]);
    await store.close();
    await expect(
      access(join(root, abandoned.id + "-notes.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(files[0]!.path, "utf8")).toBe("notes");
  });

  it("does not hand a file to Pi when its durable handoff cannot be recorded", async () => {
    const { root, store } = await fixture();
    const doc = await store.add(upload());
    const metadata = join(root, doc.id + ".json");
    await rm(metadata);
    await mkdir(metadata);
    await expect(store.resolveForPrompt([doc.id])).rejects.toThrow();
    await rm(metadata, { recursive: true });
    expect((await store.resolveForPrompt([doc.id])).files).toHaveLength(1);
  });

  it("retries initialization on the same store after a temporary storage failure is repaired", async () => {
    const parent = await mkdtemp(join(tmpdir(), "inspire-upload-retry-"));
    roots.push(parent);
    const root = join(parent, "uploads");
    await writeFile(root, "blocked");
    const store = new AttachmentStore(root, null, { sweepIntervalMs: 0 });
    stores.push(store);
    const failed = await Promise.allSettled([store.ready(), store.ready()]);
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    await rm(root);
    await expect(store.add(upload())).resolves.toMatchObject({
      fileName: "notes.txt",
    });
  });
});
