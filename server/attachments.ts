import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { MAX_ATTACHMENTS, MAX_PROJECT_FILES, type UploadedAttachment } from "../shared/contracts.js";
import { escapesBase } from "./paths.js";

interface StoredAttachment extends UploadedAttachment {
  path: string;
  /** Withdrawal lifecycle: only staged files may be deleted. A file leased
   * to an in-flight prompt or consumed by a delivered one is (about to be)
   * referenced from the conversation and must survive a racing DELETE. */
  state: "staged" | "in-flight" | "consumed";
}

function safeName(name: string): string {
  const normalized = basename(name).replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 160);
  return normalized || "attachment";
}

function isImage(mimeType: string): boolean {
  return /^image\/(png|jpe?g|gif|webp)$/i.test(mimeType);
}

export class AttachmentStore {
  private readonly values = new Map<string, StoredAttachment>();
  private initialized = false;

  constructor(
    private readonly root = join(homedir(), ".cache", "inspire", "uploads", `${process.pid}-${Date.now()}`),
  ) {}

  private async ensureRoot(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.initialized = true;
  }

  async add(file: Express.Multer.File): Promise<UploadedAttachment> {
    await this.ensureRoot();
    const id = randomUUID();
    const fileName = safeName(file.originalname);
    const path = join(this.root, `${id}-${fileName}`);
    await writeFile(path, file.buffer, { mode: 0o600, flag: "wx" });
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

  async resolveForPrompt(ids: string[] = []): Promise<{
    files: StoredAttachment[];
    images: Array<{ type: "image"; data: string; mimeType: string }>;
  }> {
    const unique = [...new Set(ids)].slice(0, MAX_ATTACHMENTS);
    const files = unique.map((id) => this.values.get(id)).filter((item): item is StoredAttachment => Boolean(item));
    if (files.length !== unique.length) throw new Error("One or more attachments expired; add them again");
    // One staging, one send: a file already leased to an in-flight prompt or
    // consumed by a delivered one cannot join a second message.
    if (files.some((file) => file.state !== "staged")) {
      throw new Error("One or more attachments already belong to another message");
    }
    // Lease before the first await: from here the prompt owns these files,
    // and a concurrent withdrawal can no longer delete them mid-delivery.
    for (const file of files) file.state = "in-flight";
    try {
      const images = await Promise.all(
        files
          .filter((item) => item.kind === "image")
          .map(async (item) => ({
            type: "image" as const,
            data: (await readFile(item.path)).toString("base64"),
            mimeType: item.mimeType,
          })),
      );
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

export async function resolveProjectFiles(cwd: string, requested: string[] = []): Promise<string[]> {
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

export function addAttachmentContext(message: string, files: StoredAttachment[], projectFiles: string[]): string {
  const ordinary = files.filter((item) => item.kind === "file").map((item) => item.path);
  const references = [...projectFiles, ...ordinary];
  if (references.length === 0) return message;
  const lines = references.map((path) => `- ${path}`);
  return `${message.trim()}\n\nReferenced files available to the agent:\n${lines.join("\n")}`.trim();
}
