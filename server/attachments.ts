import { createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { StorageEngine } from "multer";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_PROJECT_FILES,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGE_ENCODED_BYTES,
  type UploadedAttachment,
} from "../shared/contracts.js";
import { escapesBase } from "./paths.js";

interface StoredAttachment extends UploadedAttachment {
  path: string;
  /** Withdrawal lifecycle: only staged files may be deleted. A file leased
   * to an in-flight prompt or consumed by a delivered one is (about to be)
   * referenced from the conversation and must survive a racing DELETE. */
  state: "staged" | "in-flight" | "consumed";
}

function safeName(name: string): string {
  const normalized = basename(name)
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .slice(0, 160);
  return normalized || "attachment";
}

function isImage(mimeType: string): boolean {
  return /^image\/(png|jpe?g|gif|webp)$/i.test(mimeType);
}

function payloadTooLarge(message: string): Error {
  return Object.assign(new Error(message), { status: 413 });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function assertAttachmentBudget(files: readonly Express.Multer.File[]): void {
  if (files.length > MAX_ATTACHMENTS)
    throw payloadTooLarge(`At most ${MAX_ATTACHMENTS} attachments per message`);
  if (files.some((file) => file.size > MAX_ATTACHMENT_FILE_BYTES)) {
    throw payloadTooLarge(
      `Each attachment must be at most ${MAX_ATTACHMENT_FILE_BYTES} bytes`,
    );
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_ATTACHMENT_UPLOAD_BYTES) {
    throw payloadTooLarge(
      `Attachments per message must total at most ${MAX_ATTACHMENT_UPLOAD_BYTES} bytes`,
    );
  }
  const imageBytes = files.reduce(
    (sum, file) => sum + (isImage(file.mimetype) ? file.size : 0),
    0,
  );
  if (imageBytes > MAX_PROMPT_IMAGE_BYTES) {
    throw payloadTooLarge(
      `Images per message must total at most ${MAX_PROMPT_IMAGE_BYTES} bytes`,
    );
  }
}

const DEFAULT_UPLOAD_PARENT = join(homedir(), ".cache", "inspire", "uploads");

export class AttachmentStore {
  private readonly values = new Map<string, StoredAttachment>();
  private readonly root: string;
  private readonly cleanupParent: string | null;
  private initialization: Promise<void> | null = null;

  constructor(root?: string, cleanupParent?: string | null) {
    this.root = resolve(
      root ??
        join(
          DEFAULT_UPLOAD_PARENT,
          `${process.pid}-${Date.now()}-${randomUUID()}`,
        ),
    );
    this.cleanupParent =
      cleanupParent === undefined
        ? root === undefined
          ? DEFAULT_UPLOAD_PARENT
          : null
        : cleanupParent === null
          ? null
          : resolve(cleanupParent);
  }

  private async initializeRoot(): Promise<void> {
    if (this.cleanupParent) {
      await mkdir(this.cleanupParent, { recursive: true, mode: 0o700 });
      const entries = await readdir(this.cleanupParent, {
        withFileTypes: true,
      });
      await Promise.all(
        entries.map(async (entry) => {
          if (!entry.isDirectory()) return;
          const match = /^(\d+)-(\d+)(?:-|$)/u.exec(entry.name);
          if (
            !match ||
            Number(match[1]) === process.pid ||
            processExists(Number(match[1]))
          )
            return;
          await rm(join(this.cleanupParent!, entry.name), {
            recursive: true,
            force: true,
          });
        }),
      );
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  private ensureRoot(): Promise<void> {
    return (this.initialization ??= this.initializeRoot());
  }

  async uploadDirectory(): Promise<string> {
    await this.ensureRoot();
    return this.root;
  }

  temporaryUploadName(): string {
    return `.upload-${randomUUID()}`;
  }

  multerStorage(): StorageEngine {
    const requestBytes = new WeakMap<Request, number>();
    return {
      _handleFile: (request, file, done) => {
        void this.uploadDirectory().then(
          (directory) => {
            const filename = this.temporaryUploadName();
            const path = join(directory, filename);
            const output = createWriteStream(path, {
              flags: "wx",
              mode: 0o600,
            });
            let size = 0;
            let settled = false;
            const finish = (error?: Error) => {
              if (settled) return;
              settled = true;
              file.stream.unpipe(output);
              if (error) {
                output.destroy();
                file.stream.resume();
                void rm(path, { force: true });
                done(error);
                return;
              }
              done(null, { destination: directory, filename, path, size });
            };
            file.stream.on("data", (chunk: Buffer) => {
              size += chunk.length;
              const total = (requestBytes.get(request) ?? 0) + chunk.length;
              requestBytes.set(request, total);
              if (total > MAX_ATTACHMENT_UPLOAD_BYTES) {
                finish(
                  payloadTooLarge(
                    `Attachments per message must total at most ${MAX_ATTACHMENT_UPLOAD_BYTES} bytes`,
                  ),
                );
              }
            });
            file.stream.once("error", finish);
            output.once("error", finish);
            output.once("finish", () => finish());
            file.stream.pipe(output);
          },
          (error) =>
            done(error instanceof Error ? error : new Error(String(error))),
        );
      },
      _removeFile: (_request, file, done) => {
        const stored = file as Partial<Express.Multer.File>;
        const path = typeof stored.path === "string" ? stored.path : null;
        delete stored.destination;
        delete stored.filename;
        delete stored.path;
        if (!path) {
          done(null);
          return;
        }
        rm(path, { force: true }).then(() => done(null), done);
      },
    };
  }

  private async discardUpload(file: Express.Multer.File): Promise<void> {
    if (typeof file.path !== "string" || !file.path) return;
    const path = resolve(file.path);
    if (
      escapesBase(relative(this.root, path)) ||
      !basename(path).startsWith(".upload-")
    )
      return;
    await rm(path, { force: true });
  }

  private async storeFile(
    file: Express.Multer.File,
  ): Promise<UploadedAttachment> {
    await this.ensureRoot();
    const id = randomUUID();
    const fileName = safeName(file.originalname);
    const path = join(this.root, `${id}-${fileName}`);
    try {
      if (typeof file.path === "string" && file.path) {
        const temporary = resolve(file.path);
        if (escapesBase(relative(this.root, temporary)))
          throw new Error("Uploaded attachment escaped its private cache root");
        await rename(temporary, path);
        await chmod(path, 0o600);
      } else {
        await writeFile(path, file.buffer, { mode: 0o600, flag: "wx" });
      }
    } catch (error) {
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
    const value: StoredAttachment = {
      id,
      fileName,
      mimeType: file.mimetype || "application/octet-stream",
      size: file.size,
      kind: isImage(file.mimetype) ? "image" : "file",
      path,
      state: "staged",
    };
    this.values.set(id, value);
    return this.publicValue(value);
  }

  async add(file: Express.Multer.File): Promise<UploadedAttachment> {
    try {
      assertAttachmentBudget([file]);
      return await this.storeFile(file);
    } catch (error) {
      await this.discardUpload(file);
      throw error;
    }
  }

  async addMany(
    files: readonly Express.Multer.File[],
  ): Promise<UploadedAttachment[]> {
    const added: UploadedAttachment[] = [];
    try {
      assertAttachmentBudget(files);
      for (const file of files) added.push(await this.storeFile(file));
      return added;
    } catch (error) {
      await Promise.all([
        ...files.map((file) => this.discardUpload(file)),
        ...added.map((item) => this.remove(item.id)),
      ]);
      throw error;
    }
  }

  async resolveForPrompt(ids: string[] = []): Promise<{
    files: StoredAttachment[];
    images: Array<{ type: "image"; data: string; mimeType: string }>;
  }> {
    if (ids.length > MAX_ATTACHMENTS)
      throw payloadTooLarge(
        `At most ${MAX_ATTACHMENTS} attachments per message`,
      );
    const unique = [...new Set(ids)];
    const files = unique
      .map((id) => this.values.get(id))
      .filter((item): item is StoredAttachment => Boolean(item));
    if (files.length !== unique.length)
      throw new Error("One or more attachments expired; add them again");
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_ATTACHMENT_UPLOAD_BYTES) {
      throw payloadTooLarge(
        `Attachments per message must total at most ${MAX_ATTACHMENT_UPLOAD_BYTES} bytes`,
      );
    }
    const imageFiles = files.filter((item) => item.kind === "image");
    const imageBytes = imageFiles.reduce((sum, file) => sum + file.size, 0);
    if (imageBytes > MAX_PROMPT_IMAGE_BYTES) {
      throw payloadTooLarge(
        `Images per message must total at most ${MAX_PROMPT_IMAGE_BYTES} bytes`,
      );
    }
    // One staging, one send: a file already leased to an in-flight prompt or
    // consumed by a delivered one cannot join a second message.
    if (files.some((file) => file.state !== "staged")) {
      throw new Error(
        "One or more attachments already belong to another message",
      );
    }
    // Lease before the first await: from here the prompt owns these files,
    // and a concurrent withdrawal can no longer delete them mid-delivery.
    for (const file of files) file.state = "in-flight";
    try {
      const images: Array<{ type: "image"; data: string; mimeType: string }> =
        [];
      let encodedBytes = 0;
      for (const item of imageFiles) {
        const data = (await readFile(item.path)).toString("base64");
        encodedBytes += Buffer.byteLength(data);
        if (encodedBytes > MAX_PROMPT_IMAGE_ENCODED_BYTES) {
          throw payloadTooLarge(
            `Encoded images exceed the ${MAX_PROMPT_IMAGE_ENCODED_BYTES}-byte prompt budget`,
          );
        }
        images.push({ type: "image", data, mimeType: item.mimeType });
      }
      return { files, images };
    } catch (error) {
      // All-or-nothing: a rejected resolve holds no leases.
      for (const file of files) {
        if (file.state === "in-flight") file.state = "staged";
      }
      throw error;
    }
  }

  /** Remove one staged attachment (user withdrew it before sending). A file
   * leased to an in-flight prompt or consumed by a delivered one is
   * referenced from the conversation and stays; the late withdrawal is
   * moot, not an error. */
  async remove(id: string): Promise<void> {
    const value = this.values.get(id);
    if (value?.state !== "staged") return;
    this.values.delete(id);
    await rm(value.path, { force: true });
  }

  /** A prompt that failed before delivery hands its leased files back:
   * they become withdrawable (and resendable) again. */
  restage(ids: string[] = []): void {
    for (const id of ids) {
      const value = this.values.get(id);
      if (value?.state === "in-flight") value.state = "staged";
    }
  }

  /** Reclaim attachments a delivered prompt consumed. Image bytes were
   * inlined into the request, so their cache files can go; ordinary files
   * are referenced by host path inside the conversation text and are marked
   * consumed so they stay readable for the rest of the host's lifetime. */
  async releaseConsumed(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        const value = this.values.get(id);
        if (!value) return;
        if (value.kind !== "image") {
          value.state = "consumed";
          return;
        }
        this.values.delete(id);
        // Best-effort: the prompt is already delivered, so a failed cleanup
        // must not turn the response into an error the client would retry.
        await rm(value.path, { force: true }).catch(() => undefined);
      }),
    );
  }

  private publicValue(value: StoredAttachment): UploadedAttachment {
    const { path: _path, state: _state, ...publicValue } = value;
    return publicValue;
  }

  async close(): Promise<void> {
    this.values.clear();
    await rm(this.root, { recursive: true, force: true });
  }
}

export async function resolveProjectFiles(
  cwd: string,
  requested: string[] = [],
): Promise<string[]> {
  const root = await realpath(cwd);
  return Promise.all(
    [...new Set(requested)].slice(0, MAX_PROJECT_FILES).map(async (raw) => {
      const candidate = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
      const actual = await realpath(candidate);
      if (escapesBase(relative(root, actual))) {
        throw new Error(`Project file is outside the active project: ${raw}`);
      }
      return actual;
    }),
  );
}

export function addAttachmentContext(
  message: string,
  files: StoredAttachment[],
  projectFiles: string[],
): string {
  const ordinary = files
    .filter((item) => item.kind === "file")
    .map((item) => item.path);
  const references = [...projectFiles, ...ordinary];
  if (references.length === 0) return message;
  const lines = references.map((path) => `- ${path}`);
  return `${message.trim()}\n\nReferenced files available to the agent:\n${lines.join("\n")}`.trim();
}
