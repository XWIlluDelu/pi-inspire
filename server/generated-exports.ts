import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { requestError } from "./request-error.js";
import { openCanonicalResourceFile } from "./resources.js";

interface GeneratedExport {
  sessionId: string;
  path: string;
  fileName: string;
  format: "html" | "jsonl";
  expiresAt: number;
}

/** Opaque, authenticated downloads of generated snapshots, never arbitrary paths. */
export class GeneratedExportStore {
  private directory: Promise<string> | null = null;
  private readonly files = new Map<string, GeneratedExport>();

  async create(
    sessionId: string,
    format: "html" | "jsonl",
    write: (path: string) => Promise<unknown>,
  ) {
    const directory = await mkdtemp(join(tmpdir(), "inspire-export-source-"));
    const path = join(
      directory,
      `session-${new Date().toISOString().slice(0, 10)}.${format}`,
    );
    try {
      await write(path);
      return await this.add(sessionId, path, format);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async add(sessionId: string, sourcePath: string, format: "html" | "jsonl") {
    const id = randomUUID();
    const pending = (this.directory ??= mkdtemp(
      join(tmpdir(), "inspire-exports-"),
    ));
    let directory: string;
    try {
      directory = await pending;
    } catch (error) {
      if (this.directory === pending) this.directory = null;
      throw error;
    }
    const path = join(directory, id);
    const source = await openCanonicalResourceFile(sourcePath);
    try {
      await pipeline(
        source.handle.createReadStream({ autoClose: false }),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      );
      const after = await source.handle.stat({ bigint: true });
      if (
        after.size !== source.details.size ||
        after.mtimeNs !== source.details.mtimeNs ||
        after.ctimeNs !== source.details.ctimeNs
      )
        throw requestError(
          "The generated export changed while preparing its download; export again",
          409,
        );
      const fileName = basename(sourcePath);
      this.files.set(id, {
        sessionId,
        path,
        fileName,
        format,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });
      await this.prune();
      return { downloadId: id, fileName };
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    } finally {
      await source.handle.close();
    }
  }

  async get(sessionId: string, id: string): Promise<GeneratedExport> {
    await this.prune();
    const file = this.files.get(id);
    if (!file || file.sessionId !== sessionId)
      throw requestError(
        "This export download expired or belongs to another session; export again",
        404,
      );
    return file;
  }

  private async prune(): Promise<void> {
    for (const [id, file] of this.files) {
      if (file.expiresAt > Date.now() && this.files.size <= 16) continue;
      this.files.delete(id);
      await rm(file.path, { force: true });
    }
  }

  async close(): Promise<void> {
    this.files.clear();
    if (this.directory)
      await rm(await this.directory, { recursive: true, force: true });
  }
}
