import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import type { Request } from "express";
import type { StorageEngine } from "multer";
import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_ATTACHMENTS,
  MAX_PROJECT_FILES,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGE_ENCODED_BYTES,
  type UploadedAttachment,
} from "../shared/contracts.js";
import {
  type AttachmentReferenceCache,
  containsAttachmentPath,
  sessionAttachmentReferences,
} from "./attachment-references.js";
import {
  canonicalBase64DecodedSize,
  isSupportedPromptImageMimeType,
} from "./image-content.js";
import { escapesBase } from "./paths.js";
import { getAgentDir } from "./pi-runtime.js";
import { resolvePiSessionDirectory } from "./pi-session-directory.js";
import { inspireStateDirectory } from "./platform-paths.mjs";
import { requestError } from "./request-error.js";

export interface AttachmentContextFile {
  kind: "image" | "file";
  path: string;
}

interface StoredAttachment extends UploadedAttachment {
  path: string;
  /** Withdrawal lifecycle: only staged files may be deleted. A file leased
   * to an in-flight prompt or consumed by a delivered one is (about to be)
   * referenced from the conversation and must survive a racing DELETE. */
  state: "staged" | "in-flight" | "pending" | "consumed";
}

interface AttachmentOwnership extends UploadedAttachment {
  path: string;
  ownerPid: number;
}

interface AttachmentRetentionOptions {
  sessionDirectories?: readonly string[];
  trashDirectories?: readonly string[];
  /** Disable the periodic sweep in isolated fixtures. */
  sweepIntervalMs?: number;
}

interface AttachmentCollection {
  reclaimed: string[];
  deferred?: string;
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
  return requestError(message, 413);
}

function processExists(pid: number): boolean {
  if (pid <= 0) return false;
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

const DEFAULT_UPLOAD_PARENT = join(inspireStateDirectory(), "attachments");
const execFile = promisify(execFileCallback);

function nativeTrashDirectories(): string[] {
  if (process.platform === "linux") {
    const dataHome = process.env.XDG_DATA_HOME;
    return [
      join(
        dataHome && isAbsolute(dataHome)
          ? dataHome
          : join(homedir(), ".local", "share"),
        "Trash",
        "files",
      ),
    ];
  }
  if (process.platform === "darwin") return [join(homedir(), ".Trash")];
  // Recycle Bin sources are supplied below from the volumes that hold Pi
  // sessions. Access errors defer reclamation rather than losing recovery.
  return [];
}

export class AttachmentStore {
  private readonly values = new Map<string, StoredAttachment>();
  private root: string;
  private cleanupParent: string | null;
  private initialization: Promise<void> | null = null;
  private readonly owned = new Map<string, AttachmentOwnership>();
  private readonly sessionDirectories = new Set<string>();
  private readonly registeredDirectories = new Set<string>();
  private readonly awaitingReference = new Map<string, Set<string | null>>();
  private registryTail: Promise<void> = Promise.resolve();
  private readonly pathLeases = new Map<string, number>();
  private readonly referenceCache: AttachmentReferenceCache = new Map();
  private sweep: ReturnType<typeof setInterval> | null = null;
  private collecting: Promise<AttachmentCollection> | null = null;
  private closed = false;
  private windowsSid: Promise<string> | null = null;
  private directorySource:
    | (() => Promise<readonly (string | undefined)[]>)
    | null = null;

  constructor(
    root?: string,
    cleanupParent?: string | null,
    private readonly retention: AttachmentRetentionOptions = {},
  ) {
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
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.root = await realpath(this.root);
    if (this.cleanupParent)
      this.cleanupParent = await realpath(this.cleanupParent);
    for (const directory of this.retention.sessionDirectories ?? [
      join(getAgentDir(), "sessions"),
    ])
      this.sessionDirectories.add(resolve(directory));
    await this.loadOwnership();
    const interval = this.retention.sweepIntervalMs ?? 60_000;
    if (interval > 0 && !this.closed) {
      this.sweep = setInterval(() => {
        void this.collectUnreferenced();
      }, interval);
      this.sweep.unref();
    }
  }

  private async storageRoots(): Promise<string[]> {
    if (!this.cleanupParent) return [this.root];
    const entries = await readdir(this.cleanupParent, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^\d+-\d+-/u.test(entry.name))
      .map((entry) => join(this.cleanupParent!, entry.name));
  }

  private async loadOwnership(): Promise<void> {
    for (const root of await this.storageRoots()) {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (entry.name === ".session-directories.json") {
          const directories: unknown = JSON.parse(
            await readFile(join(root, entry.name), "utf8"),
          );
          if (
            !Array.isArray(directories) ||
            directories.some(
              (path) => typeof path !== "string" || !isAbsolute(path),
            )
          )
            throw new Error("Invalid attachment session-directory registry");
          for (const directory of directories) {
            this.sessionDirectories.add(directory);
            this.registeredDirectories.add(directory);
          }
          continue;
        }
        if (!/^[0-9a-f-]{36}\.json$/u.test(entry.name)) continue;
        const value: AttachmentOwnership = JSON.parse(
          await readFile(join(root, entry.name), "utf8"),
        );
        if (
          value.id !== entry.name.slice(0, -5) ||
          value.kind !== "file" ||
          typeof value.fileName !== "string" ||
          value.fileName !== safeName(value.fileName) ||
          value.path !== join(root, `${value.id}-${value.fileName}`) ||
          !Number.isInteger(value.ownerPid)
        )
          throw new Error("Invalid attachment ownership record");
        this.owned.set(value.path, value);
      }
    }
  }

  private async persistOwnership(value: StoredAttachment): Promise<void> {
    if (value.kind !== "file") return;
    const ownership: AttachmentOwnership = {
      ...this.publicValue(value),
      path: value.path,
      ownerPid: process.pid,
    };
    await writeFile(
      join(this.root, `${value.id}.json`),
      JSON.stringify(ownership),
      { mode: 0o600, flag: "wx" },
    );
    this.owned.set(value.path, ownership);
  }

  discoverSessionDirectories(
    source: () => Promise<readonly (string | undefined)[]>,
  ): void {
    this.directorySource = source;
  }

  /** Custom Pi storage is remembered independently of navigation curation. */
  async registerSession(path: string): Promise<void> {
    await this.ensureRoot();
    const directory = dirname(resolve(path));
    const writing = this.registryTail.then(async () => {
      if (this.registeredDirectories.has(directory)) return;
      const temporary = join(this.root, `.directories-${randomUUID()}`);
      try {
        await writeFile(
          temporary,
          JSON.stringify([...this.registeredDirectories, directory]),
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporary, join(this.root, ".session-directories.json"));
        this.sessionDirectories.add(directory);
        this.registeredDirectories.add(directory);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.registryTail = writing.catch(() => undefined);
    await writing;
  }

  referencedPromptFiles(text: string): string[] {
    return [...this.owned.keys()].filter((path) =>
      containsAttachmentPath(text, path),
    );
  }

  /** History references can outlive their old session while a resend owns them. */
  leasePromptFiles(paths: readonly string[]): () => void {
    for (const path of paths)
      this.pathLeases.set(path, (this.pathLeases.get(path) ?? 0) + 1);
    return () => {
      for (const path of paths) {
        const count = (this.pathLeases.get(path) ?? 1) - 1;
        if (count === 0) this.pathLeases.delete(path);
        else this.pathLeases.set(path, count);
      }
    };
  }

  retainPromptFiles(
    paths: readonly string[],
    sessionPath?: string | null,
  ): void {
    for (const path of paths) {
      if (!this.owned.has(path)) continue;
      const sessions =
        this.awaitingReference.get(path) ?? new Set<string | null>();
      sessions.add(sessionPath ? resolve(sessionPath) : null);
      this.awaitingReference.set(path, sessions);
    }
  }

  /** Negative reference evidence requires a complete session/Trash sweep. */
  async collectUnreferenced(): Promise<AttachmentCollection> {
    await this.ensureRoot();
    if (this.collecting) return this.collecting;
    const collection = this.collectInside().catch((error) => ({
      reclaimed: [],
      deferred: error instanceof Error ? error.message : String(error),
    }));
    this.collecting = collection;
    try {
      return await collection;
    } finally {
      if (this.collecting === collection) this.collecting = null;
    }
  }

  private currentWindowsSid(): Promise<string> {
    return (this.windowsSid ??= execFile(
      process.env.SystemRoot
        ? join(
            process.env.SystemRoot,
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          )
        : "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 8192, windowsHide: true },
    )
      .then(({ stdout }) => {
        const sid = stdout.trim();
        if (!/^S-\d+(?:-\d+)+$/u.test(sid))
          throw new Error("Unable to identify current-user Recycle Bin");
        return sid;
      })
      .catch((error) => {
        this.windowsSid = null;
        throw error;
      }));
  }

  private async collectInside(): Promise<AttachmentCollection> {
    await this.loadOwnership();
    if (this.owned.size === 0) return { reclaimed: [] };
    const configured = this.retention.sessionDirectories
      ? []
      : [resolvePiSessionDirectory(process.cwd())];
    for (const directory of [
      ...configured,
      ...((await this.directorySource?.()) ?? []),
    ]) {
      this.sessionDirectories.add(
        resolve(directory ?? join(getAgentDir(), "sessions")),
      );
    }
    const trash = [
      ...(this.retention.trashDirectories ?? nativeTrashDirectories()),
    ];
    if (process.platform === "win32" && !this.retention.trashDirectories) {
      const sid = await this.currentWindowsSid();
      for (const directory of this.sessionDirectories)
        trash.push(join(parse(directory).root, "$Recycle.Bin", sid));
    }
    const candidates = [...this.owned.entries()];
    const references = await sessionAttachmentReferences(
      new Set(candidates.map(([path]) => path)),
      [...this.sessionDirectories],
      trash,
      this.referenceCache,
    );
    const reclaimed: string[] = [];
    for (const [path, ownership] of candidates) {
      const waiting = this.awaitingReference.get(path);
      if (waiting) {
        for (const session of waiting) {
          if (session && references.sessions.get(session)?.has(path))
            waiting.delete(session);
        }
        if (waiting.size === 0) this.awaitingReference.delete(path);
      }
      if (references.paths.has(path)) continue;
      const local = this.values.get(ownership.id);
      if (
        local?.state === "staged" ||
        local?.state === "in-flight" ||
        this.awaitingReference.has(path) ||
        this.pathLeases.has(path)
      )
        continue;
      // Another live Host's staging/pending input is not this sweep's property.
      if (dirname(path) !== this.root && processExists(ownership.ownerPid))
        continue;
      const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stats && (!stats.isFile() || stats.isSymbolicLink()))
        throw new Error(`Owned upload was replaced: ${path}`);
      const current = this.values.get(ownership.id);
      if (
        current?.state === "staged" ||
        current?.state === "in-flight" ||
        this.awaitingReference.has(path) ||
        this.pathLeases.has(path)
      )
        continue;
      await rm(path, { force: true });
      await rm(join(dirname(path), `${ownership.id}.json`), { force: true });
      this.owned.delete(path);
      this.values.delete(ownership.id);
      reclaimed.push(path);
    }
    return { reclaimed };
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
    try {
      await this.persistOwnership(value);
    } catch (error) {
      this.values.delete(id);
      await rm(path, { force: true });
      throw error;
    }
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
      await Promise.allSettled([
        ...files.map((file) => this.discardUpload(file)),
        ...added.map(async (item) => {
          const value = this.values.get(item.id);
          if (value?.state !== "staged") return;
          this.values.delete(item.id);
          await this.removeStoredFile(value);
        }),
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
      throw requestError(
        "One or more attachments expired; add them again",
        409,
        {
          code: "ATTACHMENTS_EXPIRED",
          matches: unique.filter((id) => !this.values.has(id)),
        },
      );
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
      throw requestError(
        "One or more attachments already belong to another message",
        409,
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

  /** Recover saved images as ordinary staging, preserving order and multiplicity.
   * Message-wide send limits apply at submission so users can trim a large draft. */
  async stageImages(
    images: readonly { data: string; mimeType: string }[],
  ): Promise<UploadedAttachment[]> {
    const sizes = images.map((image) => {
      const size = canonicalBase64DecodedSize(image.data);
      if (!isSupportedPromptImageMimeType(image.mimeType) || !size)
        throw requestError("A saved image is invalid", 422);
      if (size > MAX_ATTACHMENT_FILE_BYTES)
        throw payloadTooLarge(
          `Each image must be at most ${MAX_ATTACHMENT_FILE_BYTES} bytes`,
        );
      return size;
    });
    const copied: UploadedAttachment[] = [];
    try {
      for (const [index, image] of images.entries()) {
        const extension = image.mimeType.split("/")[1]!.toLowerCase();
        copied.push(
          await this.storeFile({
            originalname: `Recovered image ${index + 1}.${extension === "jpeg" ? "jpg" : extension}`,
            mimetype: image.mimeType,
            size: sizes[index]!,
            buffer: Buffer.from(image.data, "base64"),
          } as Express.Multer.File),
        );
      }
      return copied;
    } catch (error) {
      await Promise.allSettled(copied.map((value) => this.remove(value.id)));
      throw error;
    }
  }

  /** Worker-owned copies survive queue acceptance, including resolved history
   * images that have no current upload handle. No send limit truncates recovery. */
  async holdPendingImages(
    ids: readonly string[],
    recalled: readonly { data: string; mimeType: string }[],
  ): Promise<{ attachments: UploadedAttachment[]; copiedIds: string[] }> {
    const originals = ids.flatMap((id) => {
      const value = this.values.get(id);
      return value?.kind === "image" && value.state === "in-flight"
        ? [value]
        : [];
    });
    const copied = await this.stageImages(recalled);
    for (const value of [
      ...originals,
      ...copied.map((item) => this.values.get(item.id)!),
    ])
      value.state = "pending";
    return {
      attachments: [
        ...originals.map((value) => this.publicValue(value)),
        ...copied,
      ],
      copiedIds: copied.map((value) => value.id),
    };
  }

  restorePendingImages(ids: readonly string[]): UploadedAttachment[] {
    const values = ids.map((id) => this.values.get(id));
    if (
      values.some(
        (value) => value?.kind !== "image" || value.state !== "pending",
      )
    )
      throw new Error("A pending image copy is no longer available");
    for (const value of values) value!.state = "staged";
    return values.map((value) => this.publicValue(value!));
  }

  /** Transfer/disposal checks the current owner; retirement cannot delete an
   * image already returned to the editor, even if a prompt receipt arrives late. */
  async releasePendingImages(ids: readonly string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        const value = this.values.get(id);
        if (value?.kind !== "image" || value.state !== "pending") return;
        this.values.delete(id);
        await rm(value.path, { force: true });
      }),
    );
  }

  async rejectPendingImages(
    ids: readonly string[],
    copiedIds: ReadonlySet<string>,
  ): Promise<void> {
    const originals = ids.filter((id) => !copiedIds.has(id));
    for (const id of originals) {
      const value = this.values.get(id);
      if (value?.state === "pending") value.state = "staged";
    }
    await this.releasePendingImages([...copiedIds]);
  }

  async imagePreview(id: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const value = this.values.get(id);
    if (
      value?.kind !== "image" ||
      (value.state !== "staged" && value.state !== "pending")
    )
      throw requestError("That image is no longer available", 404);
    const file = await open(
      value.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.size !== value.size ||
        before.size > MAX_ATTACHMENT_FILE_BYTES
      )
        throw requestError("The image copy changed", 409);
      const bytes = Buffer.alloc(value.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!bytesRead) throw requestError("The image copy changed", 409);
        offset += bytesRead;
      }
      const after = await file.stat();
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw requestError("The image copy changed", 409);
      return { bytes, mimeType: value.mimeType };
    } finally {
      await file.close();
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
    try {
      await this.removeStoredFile(value);
    } catch (error) {
      // Keep a failed withdrawal retryable without allowing a concurrent
      // prompt to lease the file while unlink is in flight.
      if (!this.values.has(id)) this.values.set(id, value);
      throw error;
    }
  }

  private async removeStoredFile(value: StoredAttachment): Promise<void> {
    await rm(value.path, { force: true });
    if (value.kind === "file") {
      await rm(join(this.root, `${value.id}.json`), { force: true });
      this.owned.delete(value.path);
    }
  }

  private promptFile(path: string): AttachmentOwnership | null {
    const candidate = resolve(path);
    const value = this.owned.get(candidate);
    const local = value ? this.values.get(value.id) : null;
    return value && local?.state !== "staged" ? value : null;
  }

  /** Durable ownership metadata, not persisted path text, authorizes recall. */
  ownsPromptFile(path: string): boolean {
    return this.promptFile(path) !== null;
  }

  /** Recover the user-facing name without leaking the UUID-prefixed private
   * cache basename into composer history. */
  promptFileName(path: string): string | null {
    return this.promptFile(path)?.fileName ?? null;
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
   * are referenced by host path and retained until their last session/Trash
   * reference disappears. Pending Pi input stays protected before persistence. */
  async releaseConsumed(
    ids: string[],
    sessionPath?: string | null,
    awaitReference = true,
  ): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        const value = this.values.get(id);
        if (!value) return;
        if (value.kind !== "image") {
          value.state = "consumed";
          if (awaitReference) this.retainPromptFiles([value.path], sessionPath);
          return;
        }
        // Worker artifact ownership outlives queue acceptance. Runtime excludes
        // transferred/recovered handles from that delivery's late cleanup.
        if (value.state === "pending") return;
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

  async ready(): Promise<void> {
    await this.ensureRoot();
  }

  async sessionDeleted(path: string): Promise<AttachmentCollection> {
    for (const [attachment, sessions] of this.awaitingReference) {
      sessions.delete(resolve(path));
      if (sessions.size === 0) this.awaitingReference.delete(attachment);
    }
    return this.collectUnreferenced();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sweep) clearInterval(this.sweep);
    if (!this.initialization) return;
    await this.ensureRoot();
    await this.collecting;
    for (const value of this.values.values()) {
      if (value.state === "staged" || value.kind === "image")
        await this.removeStoredFile(value);
    }
    // Runtime and HTTP drain precede close: remaining in-flight uncertainty
    // stays on disk; accepted references are reconstructed on the next Host.
    for (const ownership of this.owned.values()) {
      if (dirname(ownership.path) !== this.root) continue;
      ownership.ownerPid = 0;
      const metadata = join(this.root, `${ownership.id}.json`);
      const temporary = `${metadata}.${randomUUID()}`;
      await writeFile(temporary, JSON.stringify(ownership), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, metadata);
    }
    this.values.clear();
    this.awaitingReference.clear();
  }
}

export async function resolveProjectFiles(
  cwd: string,
  requested: string[] = [],
): Promise<string[]> {
  const unique = [...new Set(requested)];
  if (unique.length > MAX_PROJECT_FILES) {
    throw payloadTooLarge(
      `At most ${MAX_PROJECT_FILES} project files per message`,
    );
  }
  if (unique.length === 0) return [];
  const root = await realpath(cwd);
  // Selection and send are separate actions: freshly resolve each target.
  // Hidden visibility, search budgets and Git rules are not access authority.
  const resolved = await Promise.all(
    unique.map(async (raw) => {
      const candidate = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
      const actual = await realpath(candidate);
      if (escapesBase(relative(root, actual))) {
        throw new Error(`Project file is outside the active project: ${raw}`);
      }
      if (!(await stat(actual)).isFile()) {
        throw new Error(`Project path is not a regular file: ${raw}`);
      }
      return actual;
    }),
  );
  return [...new Set(resolved)];
}

const REFERENCE_CONTEXT_HEADING =
  "Referenced files available to the agent (JSON paths):";

export function addAttachmentContext(
  message: string,
  files: readonly AttachmentContextFile[],
  projectFiles: readonly string[],
): string {
  const ordinary = files
    .filter((item) => item.kind === "file")
    .map((item) => item.path);
  const references = [...projectFiles, ...ordinary];
  if (references.length === 0) return message;
  // JSON string literals keep newlines, bullet prefixes, and other legal
  // filename characters inside one unambiguous structural item.
  const lines = references.map((path) => `- ${JSON.stringify(path)}`);
  const context = `${REFERENCE_CONTEXT_HEADING}\n${lines.join("\n")}`;
  return message ? `${message}\n\n${context}` : context;
}

interface ParsedAttachmentContext {
  text: string;
  references: string[];
}

/** Recover editor text and exact file paths from INSΠRE's deterministic context. */
export function parseAttachmentContext(
  prompt: string,
): ParsedAttachmentContext {
  const heading = `${REFERENCE_CONTEXT_HEADING}\n`;
  const marker = `\n\n${heading}`;
  const trailingContext = prompt.lastIndexOf(marker);
  const contextStart =
    trailingContext >= 0
      ? trailingContext
      : prompt.startsWith(heading)
        ? 0
        : -1;
  if (contextStart < 0) return { text: prompt, references: [] };
  const referenceStart =
    contextStart === 0 ? heading.length : contextStart + marker.length;
  const references: string[] = [];
  const lines = prompt.slice(referenceStart).split("\n");
  if (
    lines.length === 0 ||
    lines.some((line) => {
      if (!line.startsWith("- ")) return true;
      try {
        const path = JSON.parse(line.slice(2));
        if (typeof path !== "string" || !isAbsolute(path)) return true;
        references.push(path);
        return false;
      } catch {
        return true;
      }
    })
  )
    return { text: prompt, references: [] };
  return {
    text: contextStart === 0 ? "" : prompt.slice(0, contextStart),
    references,
  };
}
