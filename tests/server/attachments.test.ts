import { access, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentStore,
  addAttachmentContext,
  parseAttachmentContext,
} from "../../server/attachments.js";
import {
  canonicalBase64DecodedSize,
  decodeCanonicalBase64,
} from "../../server/image-content.js";

import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_PROMPT_IMAGE_BYTES,
} from "../../shared/contracts.js";
import { isSupportedPromptImageMimeType } from "../../shared/image-types.js";

function upload(
  name: string,
  type: string,
  size?: number,
): Express.Multer.File {
  const buffer = Buffer.from("payload");
  return {
    originalname: name,
    mimetype: type,
    size: size ?? buffer.length,
    buffer,
  } as Express.Multer.File;
}

describe("attachments", () => {
  let root: string;
  let store: AttachmentStore;

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), "inspire-attachments-")),
    );
    store = new AttachmentStore(join(root, "uploads"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("bounds physical upload names without merging files or splitting display characters", async () => {
    const prefix = "研".repeat(71) + "a";
    const input = [
      [`${prefix}.txt`, `${prefix}.txt`],
      [`${prefix}b.txt`, `${prefix}b.txt`],
      ["a".repeat(159) + "𝒜", "a".repeat(159)],
      ["ΐ".repeat(100) + ".pdf", "ΐ".repeat(100) + ".pdf"],
      ["report. ", "report. "],
      ["...", "..."],
    ] as const;
    const staged = await store.addMany(
      input.map(([name]) => upload(name, "text/plain")),
    );
    expect(staged.map(({ fileName }) => fileName)).toEqual(
      input.map(([, readable]) => readable),
    );

    const { files } = await store.resolveForPrompt(staged.map(({ id }) => id));
    const physicalNames = files.map(({ path }) => basename(path));
    for (const name of physicalNames) {
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
      expect(name.normalize("NFD").length).toBeLessThanOrEqual(255);
      expect(name).not.toMatch(/[. ]$/u);
    }
    for (const name of physicalNames.slice(0, 2)) {
      expect(extname(name)).toBe(".txt");
    }
    expect(files[0]!.path).not.toBe(files[1]!.path);
    expect(extname(files[3]!.path)).toBe(".pdf");
  });

  describe("multipart upload lifetime", () => {
    it.each(["error", "close", "already-closed"])(
      "settles an upload cancelled during directory setup (%s) without creating a partial file",
      async (mode) => {
        const directory = await store.uploadDirectory();
        const before = await readdir(directory);
        let release!: (path: string) => void;
        vi.spyOn(store, "uploadDirectory").mockReturnValue(
          new Promise<string>((resolve) => {
            release = resolve;
          }),
        );
        const stream = new PassThrough();
        // Multer also observes source errors; storage must still settle its own callback.
        stream.on("error", () => {});
        const closed = new Promise<void>((resolve) =>
          stream.once("close", resolve),
        );
        if (mode === "already-closed") stream.destroy();
        const done = vi.fn();
        store
          .multerStorage()
          ._handleFile(
            {} as Request,
            { ...upload("notes.txt", "text/plain"), stream },
            done,
          );
        const error = new Error("client disconnected");
        if (mode === "error") stream.destroy(error);
        else if (mode === "close") stream.destroy();
        await closed;
        release(directory);
        await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
        expect(done.mock.calls[0]?.[0]).toBeInstanceOf(Error);
        if (mode === "error") expect(done.mock.calls[0]?.[0]).toBe(error);
        expect(await readdir(directory)).toEqual(before);
        expect(done).toHaveBeenCalledTimes(1);
      },
    );

    it("closes and removes a partial upload before reporting stream failure", async () => {
      const directory = await store.uploadDirectory();
      const before = await readdir(directory);
      const stream = new PassThrough();
      const error = new Error("client disconnected");
      const result = new Promise<Error | null>((resolve) =>
        store
          .multerStorage()
          ._handleFile(
            {} as Request,
            { ...upload("notes.txt", "text/plain"), stream },
            (reason) => resolve(reason ?? null),
          ),
      );
      stream.write("partial upload");
      await vi.waitFor(async () =>
        expect(
          (await readdir(directory)).some((name) =>
            name.startsWith(".upload-"),
          ),
        ).toBe(true),
      );
      stream.destroy(error);
      expect(await result).toBe(error);
      expect(await readdir(directory)).toEqual(before);
    });
  });

  it("validates a saved-image batch before staging any copies", async () => {
    const valid = { data: "aW1hZ2U=", mimeType: "image/png" };
    for (const invalid of [
      { ...valid, data: "invalid base64" },
      { ...valid, mimeType: "image/svg+xml" },
    ]) {
      await expect(store.stageImages([valid, invalid])).rejects.toMatchObject({
        status: 422,
      });
    }
    const attachments = await store.stageImages([valid, valid]);
    expect(attachments).toHaveLength(2);
    expect(attachments[0]!.id).not.toBe(attachments[1]!.id);
    const resolved = await store.resolveForPrompt(
      attachments.map((item) => item.id),
    );
    expect(resolved.images).toEqual([
      { type: "image", ...valid },
      { type: "image", ...valid },
    ]);
  });

  it("looks up original Pending Copy image handles without leasing or dropping missing attachments", async () => {
    const first = await store.add(upload("first.png", "image/png"));
    const second = await store.add(upload("second.png", "image/png"));
    const doc = await store.add(upload("notes.txt", "text/plain"));
    expect(
      store.pendingCopyImageIds([second.id, doc.id, first.id, second.id]),
    ).toEqual([second.id, first.id]);
    expect(store.pendingCopyImageIds([doc.id])).toEqual([]);
    expect(store.pendingCopyImageIds([])).toEqual([]);
    expect(() => store.pendingCopyImageIds([first.id, "missing"])).toThrow(
      "Original pending images are unavailable",
    );

    // Lookup leaves staging available to its actual delivery owner.
    await store.resolveForPrompt([first.id]);
    expect(() => store.pendingCopyImageIds([first.id])).toThrow(
      "Original pending images are unavailable",
    );
    await store.holdPendingImages([first.id], []);
    expect(store.pendingCopyImageIds([first.id])).toEqual([first.id]);
    await store.remove(second.id);
    expect(() => store.pendingCopyImageIds([second.id])).toThrow(
      "Original pending images are unavailable",
    );
  });

  it("keeps an in-flight lease exclusive and allows withdrawal after a failed delivery", async () => {
    const doc = await store.add(upload("draft.txt", "text/plain"));
    const { files } = await store.resolveForPrompt([doc.id]);
    const path = files[0]!.path;
    await expect(store.resolveForPrompt([doc.id])).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/already belong/),
    });

    await store.remove(doc.id);
    await expect(access(path)).resolves.toBeUndefined();

    store.restage([doc.id]);
    await store.remove(doc.id);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.resolveForPrompt([doc.id])).rejects.toMatchObject({
      status: 409,
      code: "ATTACHMENTS_EXPIRED",
      matches: [doc.id],
    });
  });

  it("enforces upload limits and counts only prompt images against the image budget", async () => {
    await expect(
      store.add(
        upload(
          "too-large.bin",
          "application/octet-stream",
          MAX_ATTACHMENT_FILE_BYTES + 1,
        ),
      ),
    ).rejects.toThrow(/Each attachment/);

    const size = Math.floor(MAX_PROMPT_IMAGE_BYTES / 2) + 1;
    const ordinary = await store.addMany([
      upload("one.bmp", "image/bmp", size),
      upload("two.svg", "image/svg+xml", size),
    ]);
    expect(ordinary.map(({ kind }) => kind)).toEqual(["file", "file"]);
    const resolved = await store.resolveForPrompt(ordinary.map(({ id }) => id));
    expect(resolved.images).toEqual([]);
    expect(resolved.files).toHaveLength(2);
    const first = await store.add(upload("one.png", "image/png", size));
    const second = await store.add(upload("two.png", "image/png", size));
    await expect(store.resolveForPrompt([first.id, second.id])).rejects.toThrow(
      new RegExp(String(MAX_PROMPT_IMAGE_BYTES)),
    );
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

  it("encodes unusual file names as structural JSON path items", () => {
    const prompt = addAttachmentContext(
      "Inspect",
      [],
      ["/project/good\n- /etc/passwd"],
    );
    expect(prompt).toContain('"/project/good\\n- /etc/passwd"');
    expect(prompt).not.toContain("\n- /etc/passwd\n");
    expect(parseAttachmentContext(prompt)).toEqual({
      text: "Inspect",
      references: ["/project/good\n- /etc/passwd"],
    });
    const spaced = "  Preserve leading and trailing whitespace.  \n";
    expect(
      parseAttachmentContext(
        addAttachmentContext(spaced, [], ["/project/spaced.txt"]),
      ).text,
    ).toBe(spaced);
    expect(
      parseAttachmentContext(
        addAttachmentContext("", [], ["/project/only-reference.txt"]),
      ).text,
    ).toBe("");
  });

  describe("image content", () => {
    it("accepts canonical padded or unpadded base64", () => {
      const encoded = Buffer.from("hello").toString("base64");
      expect(canonicalBase64DecodedSize(encoded)).toBe(5);
      expect(canonicalBase64DecodedSize(encoded.replace(/=+$/u, ""))).toBe(5);
      expect(decodeCanonicalBase64(encoded)?.toString()).toBe("hello");
    });

    it("rejects malformed padding, whitespace, nonzero trailing bits, and empty image data", () => {
      for (const value of ["TQ=", "TQ===", "T Q==", "TR==", "A"]) {
        expect(canonicalBase64DecodedSize(value)).toBeNull();
      }
      expect(decodeCanonicalBase64("")).toBeNull();
    });

    it("accepts only Pi prompt image media types", () => {
      expect(isSupportedPromptImageMimeType("image/png")).toBe(true);
      expect(isSupportedPromptImageMimeType("image/JPG")).toBe(true);
      expect(isSupportedPromptImageMimeType("image/svg+xml")).toBe(false);
      expect(isSupportedPromptImageMimeType("text/html")).toBe(false);
    });
  });
});
