import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionAttachmentReferences } from "../../server/attachment-references.js";
import {
  AttachmentStore,
  addAttachmentContext,
} from "../../server/attachments.js";
import { moveToDesktopTrash } from "../../server/desktop-trash.js";
import { resolveComposerHistoryArtifacts } from "../../server/runtime-composer-artifacts.js";
import { createRuntimeSlot } from "../../server/runtime-slot.js";
import { deleteSessionFile } from "../../server/session-delete.js";
import { SessionMetadataIndex } from "../../server/session-metadata.js";
import { SessionProjection } from "../../server/session-projection.js";

const upload = (name = "notes with spaces.txt") =>
  ({
    originalname: name,
    mimetype: "text/plain",
    size: 7,
    buffer: Buffer.from("payload"),
  }) as Express.Multer.File;

let root: string;
let sessions: string;
let trash: string;
let store: AttachmentStore;
const stores: AttachmentStore[] = [];
function openStore(directory = join(root, "uploads")) {
  const value = new AttachmentStore(directory, null, {
    sessionDirectories: [sessions],
    trashDirectories: [trash],
    sweepIntervalMs: 0,
  });
  stores.push(value);
  return value;
}
async function session(name: string, path: string) {
  const file = join(sessions, `${name}.jsonl`);
  await writeFile(
    file,
    [
      {
        type: "session",
        version: 3,
        id: name,
        cwd: root,
        timestamp: "2026-10-02T00:00:00Z",
      },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-10-02T00:00:01Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: addAttachmentContext(
                "Read this",
                [{ kind: "file", path }],
                [],
              ),
            },
          ],
          timestamp: 1,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  await store.registerSession(file);
  return file;
}
async function sent(name = "original") {
  const doc = await store.add(upload());
  const { files } = await store.resolveForPrompt([doc.id]);
  const path = files[0]!.path;
  const file = await session(name, path);
  await store.releaseConsumed([doc.id], file);
  expect((await store.collectUnreferenced()).deferred).toBeUndefined();
  return { doc, path, file };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inspire-attachment-retention-"));
  sessions = join(root, "sessions");
  trash = join(root, "data", "Trash", "files");
  await mkdir(sessions);
  store = openStore();
});
afterEach(async () => {
  for (const value of stores.splice(0)) await value.close();
  await rm(root, { recursive: true, force: true });
});

describe("durable owned upload references", () => {
  it("retains default-store copies across fresh processes and reclaims their last reference", async () => {
    const environment = {
      ...process.env,
      HOME: join(root, "home"),
      USERPROFILE: join(root, "home"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_DATA_HOME: join(root, "data"),
      APPDATA: join(root, "appdata"),
      LOCALAPPDATA: join(root, "localappdata"),
      PI_CODING_AGENT_DIR: join(root, "agent"),
    };
    const phase = async (name: string) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("tests/fixtures/attachment-retention-process.ts"),
          name,
          root,
        ],
        { env: environment },
      );
      return JSON.parse(stdout.trim());
    };
    const first = await phase("send");
    const resumed = await phase("read");
    expect(resumed.pid).not.toBe(first.pid);
    expect(resumed).toMatchObject({
      owns: true,
      name: "report with spaces.txt",
      bytes: "payload",
      reclaimed: [],
    });
    expect(resumed.deferred).toBeUndefined();
    expect(resumed.session).toContain(first.path);
    expect((await phase("delete")).reclaimed).toEqual([first.path]);
    await expect(access(first.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("survives normal Host close/reopen and recalls the original name and readable bytes", async () => {
    const { doc, path, file } = await sent();
    await store.close();
    store = openStore();
    await store.ready();
    expect(store.ownsPromptFile(path)).toBe(true);
    expect(store.promptFileName(path)).toBe(doc.fileName);
    const record = (await new SessionMetadataIndex().list([sessions]))[0]!;
    const projection = await SessionProjection.open(record);
    const slot = createRuntimeSlot({
      id: record.id,
      cwd: root,
      sessionPath: file,
      process: null,
      preview: null,
      projection,
      bridge: null,
      branchRevision: projection.revision,
      incarnationId: "test",
      viewId: "view",
    });
    const entry = projection.composerHistoryPage(
      0,
      projection.leafId,
      slot.viewId,
      root,
      (path) => store.promptFileName(path),
    ).entries[0]!;
    expect(entry.files[0]!.fileName).toBe(doc.fileName);
    const recalled = await resolveComposerHistoryArtifacts(
      slot,
      {
        sessionId: record.id,
        message: entry.text,
        historyArtifacts: {
          viewId: slot.viewId,
          incarnation: projection.incarnation,
          effectiveLeafId: projection.leafId,
          imageReferences: [],
          fileReferences: entry.files.map((file) => file.reference),
        },
      },
      store,
    );
    expect(recalled.files).toEqual([{ kind: "file", path }]);
    expect(await readFile(path, "utf8")).toBe("payload");
    await projection.close();
  });

  it("retains JSON-escaped upload paths across restart and reclaims the last reference", async () => {
    await store.close();
    // Backslashes are ordinary filename characters on Unix and separators on
    // Windows; both require escaping inside the generated JSON path literal.
    store = openStore(join(root, "uploads\\encoded"));
    const { path, file } = await sent("encoded");
    const text = addAttachmentContext(
      "Return this",
      [{ kind: "file", path }],
      [],
    );
    expect(store.referencedPromptFiles(text)).toEqual([path]);
    await store.close();
    store = openStore(join(root, "uploads\\encoded"));
    expect((await store.collectUnreferenced()).reclaimed).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("payload");
    await rm(file);
    expect((await store.collectUnreferenced()).reclaimed).toEqual([path]);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recognizes JSON-encoded Windows-shaped references on every platform", async () => {
    const path = String.raw`C:\Users\Someone\AppData\Local\inspire\attachments\notes.txt`;
    await session("windows-path", path);
    const references = await sessionAttachmentReferences(
      new Set([path]),
      [sessions],
      [],
      new Map(),
    );
    expect([...references.paths]).toEqual([path]);
  });

  it("keeps shared forks and every retained branch; reclaims only the last reference", async () => {
    const { path, file } = await sent();
    const fork = await session("fork", path);
    // A reference in an old, non-current branch still owns the upload.
    await writeFile(
      fork,
      JSON.stringify({
        type: "message",
        id: "new-root",
        parentId: null,
        message: { role: "user", content: "unrelated current branch" },
      }) + "\n",
      { flag: "a" },
    );
    await rm(file);
    expect((await store.collectUnreferenced()).reclaimed).toEqual([]);
    await expect(access(path)).resolves.toBeUndefined();
    await rm(fork);
    expect((await store.collectUnreferenced()).reclaimed).toEqual([path]);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps recoverable Trash references across restart, restores, then releases after emptying Trash", async () => {
    const { path, file } = await sent();
    const records = await new SessionMetadataIndex().list([sessions]);
    expect(
      await deleteSessionFile(records[0]!, (payload, original) =>
        moveToDesktopTrash(payload, original, {
          platform: "linux",
          environment: { XDG_DATA_HOME: join(root, "data") },
          home: root,
        }),
      ),
    ).toBe("trashed");
    expect((await store.sessionDeleted(file)).reclaimed).toEqual([]);
    await store.close();
    store = openStore();
    expect((await store.collectUnreferenced()).reclaimed).toEqual([]);
    const { readdir } = await import("node:fs/promises");
    const trashed = join(trash, (await readdir(trash))[0]!);
    await rename(trashed, file);
    expect((await store.collectUnreferenced()).reclaimed).toEqual([]);
    await moveToDesktopTrash(file, file, {
      platform: "linux",
      environment: { XDG_DATA_HOME: join(root, "data") },
      home: root,
    });
    await rm(trash, { recursive: true });
    expect((await store.collectUnreferenced()).reclaimed).toEqual([path]);
  });

  it("reclaims after permanent deletion without touching source/project/unregistered files", async () => {
    const { path, file } = await sent();
    const unrelated = join(root, "source.txt");
    const unknownUpload = join(root, "uploads", "not-owned.txt");
    await writeFile(unrelated, "original");
    await writeFile(unknownUpload, "unregistered");
    const record = (await new SessionMetadataIndex().list([sessions]))[0]!;
    expect(
      await deleteSessionFile(record, async () => {
        throw new Error("Trash unavailable");
      }),
    ).toBe("deleted");
    expect((await store.sessionDeleted(file)).reclaimed).toEqual([path]);
    expect(await readFile(unrelated, "utf8")).toBe("original");
    expect(await readFile(unknownUpload, "utf8")).toBe("unregistered");
    expect(store.ownsPromptFile(unrelated)).toBe(false);
  });

  it("protects staged/in-flight uploads and recalled resends during last-session removal", async () => {
    const staged = await store.add(upload("staged.txt"));
    const { files } = await store.resolveForPrompt([staged.id]);
    expect((await store.collectUnreferenced()).reclaimed).toEqual([]);
    store.restage([staged.id]);
    expect((await store.collectUnreferenced()).reclaimed).toEqual([]);
    await expect(access(files[0]!.path)).resolves.toBeUndefined();
    const { path, file } = await sent();
    const release = store.leasePromptFiles([path]);
    await rm(file);
    expect((await store.collectUnreferenced()).reclaimed).toEqual([]);
    release();
    expect((await store.collectUnreferenced()).reclaimed).toEqual([path]);
    await store.remove(staged.id);
  });

  it("does not confuse an old retained reference with a queued resend's persistence", async () => {
    const { path, file } = await sent();
    const destination = join(sessions, "destination.jsonl");
    await store.registerSession(destination);
    store.retainPromptFiles([path], destination);
    expect((await store.collectUnreferenced()).reclaimed).toEqual([]);
    await rm(file);
    expect((await store.collectUnreferenced()).reclaimed).toEqual([]);
    await session("destination", path);
    expect((await store.collectUnreferenced()).reclaimed).toEqual([]);
    await rm(destination);
    expect((await store.collectUnreferenced()).reclaimed).toEqual([path]);
  });

  it("remembers custom storage independently of catalog/curation after restart", async () => {
    const { path, file } = await sent();
    const custom = join(root, "custom");
    await mkdir(custom);
    const customFile = join(custom, "retained.jsonl");
    await rename(file, customFile);
    await store.registerSession(customFile);
    await store.close();
    store = openStore();
    expect((await store.collectUnreferenced()).reclaimed).toEqual([]);
    await rm(customFile);
    expect((await store.collectUnreferenced()).reclaimed).toEqual([path]);
  });

  it("retains private deletion-recovery and Recycle Bin payloads without reading binary restore metadata", async () => {
    const { path, file } = await sent();
    const recovery = join(sessions, ".inspire-delete-fixture");
    await mkdir(recovery);
    await rename(file, join(recovery, "payload"));
    expect((await store.collectUnreferenced()).reclaimed).toEqual([]);
    await mkdir(trash, { recursive: true });
    await rename(join(recovery, "payload"), join(trash, "$Rfixture.jsonl"));
    await writeFile(join(trash, "$Ifixture.jsonl"), Buffer.from([0, 1, 2, 3]));
    expect((await store.collectUnreferenced()).reclaimed).toEqual([]);
    await rm(trash, { recursive: true });
    expect((await store.collectUnreferenced()).reclaimed).toEqual([path]);
  });

  it("includes configured catalog storage roots without a paginated/curated session list", async () => {
    const { path, file } = await sent();
    const configured = join(root, "configured");
    await mkdir(configured);
    await rename(file, join(configured, "external-fork.jsonl"));
    store.discoverSessionDirectories(async () => [configured]);
    expect((await store.collectUnreferenced()).reclaimed).toEqual([]);
    await rm(configured, { recursive: true });
    expect((await store.collectUnreferenced()).reclaimed).toEqual([path]);
  });

  it("ignores unrelated valid JSONL Trash while reclaiming only orphaned owned copies", async () => {
    const { path, file } = await sent();
    await rm(file);
    await mkdir(trash, { recursive: true });
    const unrelated = join(trash, "application-log.jsonl");
    const contents = '{"event":"application_started","level":"info"}\n';
    await writeFile(unrelated, contents);
    await expect(
      sessionAttachmentReferences(
        new Set([path]),
        [sessions],
        [trash],
        new Map(),
      ),
    ).resolves.toEqual({ paths: new Set(), sessions: new Map() });
    await expect(store.collectUnreferenced()).resolves.toEqual({
      reclaimed: [path],
    });
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(unrelated, "utf8")).toBe(contents);
  });

  it.each([
    '{"type":"session","id":"broken"}\nnot-json\n',
    '{"type":"session","id":"broken"}\n{"type":"message"',
    '{"type":"session"}\n',
    '{"type":"session","id":"broken"',
    '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"lost header"}}\n',
  ])(
    "still defers orphan reclamation for corrupt Pi Trash: %s",
    async (contents) => {
      const { path, file } = await sent();
      await rm(file);
      await mkdir(trash, { recursive: true });
      await writeFile(
        join(trash, "application-log.jsonl"),
        '{"event":"application_started"}\n',
      );
      await writeFile(join(trash, "broken-session.jsonl"), contents);
      const result = await store.collectUnreferenced();
      expect(result.reclaimed).toEqual([]);
      expect(result.deferred).toMatch(/Incomplete|invalid|malformed/);
      await expect(access(path)).resolves.toBeUndefined();
    },
  );

  it("defers destructive cleanup when a retained session is malformed or incomplete", async () => {
    const { path, file } = await sent();
    await rm(file);
    await writeFile(
      join(sessions, "broken.jsonl"),
      '{"type":"session","id":"broken"}\n{"type":"message"',
    );
    const result = await store.collectUnreferenced();
    expect(result.reclaimed).toEqual([]);
    expect(result.deferred).toMatch(/Incomplete Pi session/);
    await expect(access(path)).resolves.toBeUndefined();
    await writeFile(
      join(sessions, "broken.jsonl"),
      '{"type":"session","id":"broken"}\nnot-json\n',
    );
    expect((await store.collectUnreferenced()).deferred).toMatch(
      /malformed complete JSONL/,
    );
    await expect(access(path)).resolves.toBeUndefined();
  });
});
