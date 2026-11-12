import { type ChildProcess, spawn } from "node:child_process";
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
import { basename, join } from "node:path";
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
function upload(name = "notes.txt"): Express.Multer.File {
  return {
    originalname: name,
    mimetype: "text/plain",
    buffer: Buffer.from("notes"),
    size: 5,
  } as Express.Multer.File;
}
async function owner(parent: string) {
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
  it("reclaims only unsubmitted copies when their owner exits without cleanup", async () => {
    const { parent, store } = await fixture();
    const { child, records, root } = await owner(parent);
    const staged = records.slice(0, 2);
    const [possiblyDeliveredFile, possiblyDeliveredImage] = records.slice(2);
    expect(records.map(({ delivery }) => delivery)).toEqual([
      "unsubmitted",
      "unsubmitted",
      "possible",
      "possible",
    ]);
    const unrelated = join(root, "unrelated.txt");
    await writeFile(unrelated, "keep");

    expect(await store.collectStaged()).toEqual({ reclaimed: [] });
    await stop(child);
    expect((await store.collectStaged()).reclaimed.sort()).toEqual(
      staged.map(({ path }) => path).sort(),
    );
    for (const { id, path } of staged) {
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(root, id + ".json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(await readFile(unrelated, "utf8")).toBe("keep");
    await expect(access(possiblyDeliveredFile.path)).resolves.toBeUndefined();
    await expect(access(possiblyDeliveredImage.path)).resolves.toBeUndefined();
    expect(store.ownsPromptFile(possiblyDeliveredFile.path)).toBe(true);
    expect(store.ownsPromptFile(possiblyDeliveredImage.path)).toBe(false);
  });

  it.each([
    { version: undefined, name: "legacy.txt" },
    { version: undefined, name: "字".repeat(100) + ".txt" },
    { version: 2, name: "legacy.txt" },
  ])(
    "keeps existing version $version assets recallable and unchanged ($name)",
    async ({ version, name }) => {
      const { parent, store } = await fixture();
      const root = join(parent, "3-3-existing");
      await mkdir(root);
      const id = randomUUID(),
        path = join(root, id + "-" + name);
      const record = {
        version,
        id,
        fileName: name,
        mimeType: "text/plain",
        kind: "file",
        size: 4,
        path,
        ownerPid: 0,
      };
      const metadata = JSON.stringify(record);
      // A long unversioned name fits NTFS but cannot be created on POSIX.
      const canWrite =
        process.platform === "win32" ||
        Buffer.byteLength(basename(path)) <= 255;
      if (canWrite) await writeFile(path, "keep");
      await writeFile(join(root, id + ".json"), metadata);
      expect(await store.collectStaged()).toEqual({ reclaimed: [] });
      expect(store.promptFileName(path)).toBe(name);
      if (canWrite) expect(await readFile(path, "utf8")).toBe("keep");
      expect(await readFile(join(root, id + ".json"), "utf8")).toBe(metadata);
    },
  );

  it("does not grant recall or deletion authority to unknown or mismatched ownership records", async () => {
    const { parent, store } = await fixture();
    const root = join(parent, "3-3-existing");
    await mkdir(root);
    for (const version of [3, 99]) {
      const id = randomUUID();
      const fileName = "notes.txt";
      const path = join(
        root,
        version === 3 ? "unrelated.txt" : `${id}-${fileName}`,
      );
      await writeFile(path, "keep");
      await writeFile(
        join(root, `${id}.json`),
        JSON.stringify({
          version,
          id,
          fileName,
          path,
          ownerPid: 0,
          delivery: "unsubmitted",
          kind: "file",
          mimeType: "text/plain",
          size: 4,
        }),
      );
      expect(await store.collectStaged()).toEqual({ reclaimed: [] });
      expect(store.ownsPromptFile(path)).toBe(false);
      expect(await readFile(path, "utf8")).toBe("keep");
    }
  });

  it("removes staged copies on shutdown and reloads the complete name of a delivered file", async () => {
    const { parent, root, store } = await fixture();
    const abandoned = await store.add(upload());
    const name = "文".repeat(100) + ".txt";
    const delivered = await store.add(upload(name));
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
    const reopened = new AttachmentStore(join(parent, "4-4-reopened"), parent, {
      sweepIntervalMs: 0,
    });
    stores.push(reopened);
    expect(await reopened.collectStaged()).toEqual({ reclaimed: [] });
    const path = files[0]!.path;
    expect(reopened.promptFileName(path)).toBe(name);
    expect(await readFile(path, "utf8")).toBe("notes");
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
