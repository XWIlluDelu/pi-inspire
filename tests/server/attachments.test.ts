import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";

function upload(name: string, type: string): Express.Multer.File {
  const buffer = Buffer.from("payload");
  return { originalname: name, mimetype: type, size: buffer.length, buffer } as Express.Multer.File;
}

describe("attachment consumption lifecycle", () => {
  let root: string;
  let store: AttachmentStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inspire-attachments-"));
    store = new AttachmentStore(join(root, "uploads"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps consumed ordinary files through later withdrawals and reclaims consumed images", async () => {
    const doc = await store.add(upload("notes.txt", "text/plain"));
    const image = await store.add(upload("shot.png", "image/png"));
    expect(doc).not.toHaveProperty("state");
    expect(doc).not.toHaveProperty("path");
    const resolved = await store.resolveForPrompt([doc.id, image.id]);
    const paths = new Map(resolved.files.map((item) => [item.id, item.path]));

    await store.releaseConsumed([doc.id, image.id]);
    // Image bytes travelled inside the prompt; the cache copy is gone.
    await expect(access(paths.get(image.id)!)).rejects.toThrow();
    // The conversation references the ordinary file by host path; a late
    // withdrawal (a DELETE racing the delivered prompt) must not destroy it.
    await store.remove(doc.id);
    await expect(access(paths.get(doc.id)!)).resolves.toBeUndefined();
  });

  it("shields in-flight files from withdrawal and restages them when delivery fails", async () => {
    const doc = await store.add(upload("draft.txt", "text/plain"));
    const resolved = await store.resolveForPrompt([doc.id]);
    const path = resolved.files[0]!.path;

    // A DELETE landing while the prompt is still delivering must not
    // destroy the file the message will reference.
    await store.remove(doc.id);
    await expect(access(path)).resolves.toBeUndefined();

    // Failed delivery restages the file; withdrawal works again.
    store.restage([doc.id]);
    await store.remove(doc.id);
    await expect(access(path)).rejects.toThrow();
    await expect(store.resolveForPrompt([doc.id])).rejects.toThrow(/expired/);
  });

  it("refuses to lease a file already claimed by another prompt", async () => {
    const doc = await store.add(upload("notes.txt", "text/plain"));
    const first = await store.resolveForPrompt([doc.id]);
    await expect(store.resolveForPrompt([doc.id])).rejects.toThrow(/already belong/);

    // The rejected prompt held nothing: the first lease still shields the file.
    await store.remove(doc.id);
    await expect(access(first.files[0]!.path)).resolves.toBeUndefined();

    // Consumed files are equally unavailable to a new prompt.
    await store.releaseConsumed([doc.id]);
    await expect(store.resolveForPrompt([doc.id])).rejects.toThrow(/already belong/);
  });

  it("holds no leases when resolving fails partway", async () => {
    const image = await store.add(upload("shot.png", "image/png"));
    const first = await store.resolveForPrompt([image.id]);
    store.restage([image.id]);
    await rm(first.files[0]!.path, { force: true }); // simulate disk loss
    const doc = await store.add(upload("notes.txt", "text/plain"));

    await expect(store.resolveForPrompt([doc.id, image.id])).rejects.toThrow();
    // The failed resolve rolled back: the document is still withdrawable.
    await store.remove(doc.id);
    await expect(store.resolveForPrompt([doc.id])).rejects.toThrow(/expired/);
  });
});
