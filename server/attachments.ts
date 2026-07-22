import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { MAX_ATTACHMENTS, MAX_PROJECT_FILES, type UploadedAttachment } from "../shared/contracts.js";

interface StoredAttachment extends UploadedAttachment {
  path: string;
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
  }

  private publicValue(value: StoredAttachment): UploadedAttachment {
    const { path: _path, ...publicValue } = value;
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
      const rel = relative(root, actual);
      if (rel.startsWith("..") || isAbsolute(rel)) {
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
