import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AttachmentStore,
  addAttachmentContext,
  parseAttachmentContext,
  promptTextWithoutAttachmentContext,
  resolveProjectFiles,
} from "../../server/attachments.js";

const execFileAsync = promisify(execFile);

import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_PROMPT_IMAGE_BYTES,
} from "../../shared/contracts.js";

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
    expect(store.ownsPromptFile("/not-owned")).toBe(false);
    const resolved = await store.resolveForPrompt([doc.id, image.id]);
    const paths = new Map(resolved.files.map((item) => [item.id, item.path]));
    expect(store.ownsPromptFile(paths.get(doc.id)!)).toBe(true);

    await store.releaseConsumed([doc.id, image.id]);
    expect(store.ownsPromptFile(paths.get(doc.id)!)).toBe(true);
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
    await expect(store.resolveForPrompt([doc.id])).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/expired/),
    });
  });

  it("refuses to lease a file already claimed by another prompt", async () => {
    const doc = await store.add(upload("notes.txt", "text/plain"));
    const first = await store.resolveForPrompt([doc.id]);
    await expect(store.resolveForPrompt([doc.id])).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/already belong/),
    });

    // The rejected prompt held nothing: the first lease still shields the file.
    await store.remove(doc.id);
    await expect(access(first.files[0]!.path)).resolves.toBeUndefined();

    // Consumed files are equally unavailable to a new prompt.
    await store.releaseConsumed([doc.id]);
    await expect(store.resolveForPrompt([doc.id])).rejects.toThrow(
      /already belong/,
    );
  });

  it("enforces aggregate upload and prompt-image budgets before leasing files", async () => {
    await expect(
      store.add(
        upload(
          "too-large.bin",
          "application/octet-stream",
          MAX_ATTACHMENT_FILE_BYTES + 1,
        ),
      ),
    ).rejects.toThrow(/Each attachment/);
    await expect(
      store.addMany([
        upload(
          "one.bin",
          "application/octet-stream",
          MAX_ATTACHMENT_FILE_BYTES,
        ),
        upload(
          "two.bin",
          "application/octet-stream",
          MAX_ATTACHMENT_FILE_BYTES,
        ),
        upload("three.bin", "application/octet-stream", 1),
      ]),
    ).rejects.toThrow(new RegExp(String(MAX_ATTACHMENT_UPLOAD_BYTES)));

    const first = await store.add(
      upload(
        "one.png",
        "image/png",
        Math.floor(MAX_PROMPT_IMAGE_BYTES / 2) + 1,
      ),
    );
    const second = await store.add(
      upload(
        "two.png",
        "image/png",
        Math.floor(MAX_PROMPT_IMAGE_BYTES / 2) + 1,
      ),
    );
    await expect(store.resolveForPrompt([first.id, second.id])).rejects.toThrow(
      new RegExp(String(MAX_PROMPT_IMAGE_BYTES)),
    );
    await store.remove(first.id);
    await store.remove(second.id);
  });

  it("removes dead-process upload roots before accepting a new upload", async () => {
    const parent = join(root, "managed");
    let deadPid = 999_999;
    while (true) {
      try {
        process.kill(deadPid, 0);
        deadPid += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        deadPid += 1;
      }
    }
    const stale = join(parent, `${deadPid}-${Date.now() - 60_000}`);
    const current = join(parent, `${process.pid}-${Date.now()}-current`);
    await mkdir(stale, { recursive: true });
    const managed = new AttachmentStore(current, parent);
    await managed.uploadDirectory();
    await expect(access(stale)).rejects.toThrow();
    await expect(access(current)).resolves.toBeUndefined();
    await managed.close();
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

  it("revalidates project-index authority after a selected symlink is retargeted", async () => {
    const project = join(root, "project");
    await mkdir(project);
    await execFileAsync("git", ["-C", project, "init", "-q"]);
    await writeFile(join(project, ".gitignore"), "secret.txt\n");
    await writeFile(join(project, "tracked.txt"), "tracked\n");
    await writeFile(join(project, "secret.txt"), "secret\n");
    await symlink("tracked.txt", join(project, "selected.txt"));
    await execFileAsync("git", [
      "-C",
      project,
      "add",
      ".gitignore",
      "tracked.txt",
      "selected.txt",
    ]);

    await rm(join(project, "selected.txt"));
    await symlink("secret.txt", join(project, "selected.txt"));
    await expect(
      resolveProjectFiles(project, ["selected.txt"]),
    ).rejects.toThrow(/no longer in the project index/);
    await expect(
      resolveProjectFiles(project, ["tracked.txt"]),
    ).resolves.toEqual([join(project, "tracked.txt")]);
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
    expect(promptTextWithoutAttachmentContext(prompt)).toBe("Inspect");
    const spaced = "  Preserve leading and trailing whitespace.  \n";
    expect(
      promptTextWithoutAttachmentContext(
        addAttachmentContext(spaced, [], ["/project/spaced.txt"]),
      ),
    ).toBe(spaced);
    expect(
      promptTextWithoutAttachmentContext(
        addAttachmentContext("", [], ["/project/only-reference.txt"]),
      ),
    ).toBe("");
  });
});
