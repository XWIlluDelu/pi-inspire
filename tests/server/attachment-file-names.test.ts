import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttachmentStore,
  addAttachmentContext,
} from "../../server/attachments.js";
import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "./fixtures/host-api.js";

const roots: string[] = [],
  stores: AttachmentStore[] = [];
const hosts: Awaited<ReturnType<typeof hostApiFixture>>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await closeHostApiFixture(host);
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function upload(
  name: string,
  payload = "readable payload",
): Express.Multer.File {
  const buffer = Buffer.from(payload);
  return {
    originalname: name,
    mimetype: "text/plain",
    size: buffer.length,
    buffer,
  } as Express.Multer.File;
}
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-upload-name-")),
  );
  roots.push(root);
  const uploads = join(root, "uploads"),
    sessions = join(root, "sessions");
  await mkdir(sessions);
  const open = () => {
    const store = new AttachmentStore(uploads, null, {
      sweepIntervalMs: 0,
    });
    stores.push(store);
    return store;
  };
  const session = async (path: string) => {
    const file = join(sessions, "retained.jsonl");
    await writeFile(
      file,
      [
        { type: "session", id: "filename-retention", cwd: root },
        {
          type: "message",
          message: {
            role: "user",
            content: addAttachmentContext("Read", [{ kind: "file", path }], []),
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    return file;
  };
  return { root, uploads, open, session, store: open() };
}
function expectPortable(path: string) {
  const name = basename(path);
  expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(255);
  expect(name.normalize("NFD").length).toBeLessThanOrEqual(255);
  expect(Buffer.from(name, "utf8").toString("utf8")).toBe(name);
  expect(name).not.toMatch(/[. ]$/u);
}

describe("portable attachment cache components", { timeout: 30_000 }, () => {
  it("keeps the full readable Chinese display name while bounding the actual UUID-prefixed file", async () => {
    const f = await fixture(),
      name = "研".repeat(100) + ".txt";
    const doc = await f.store.add(upload(name));
    expect(doc.fileName).toBe(name);
    expect(Buffer.byteLength(doc.id + "-" + name, "utf8")).toBeGreaterThan(255);
    const { files } = await f.store.resolveForPrompt([doc.id]);
    const file = files[0]!;
    expectPortable(file.path);
    expect(file.path).toMatch(/\.txt$/u);
    expect(file.fileName).toBe(name);
    expect(await readFile(file.path, "utf8")).toBe("readable payload");
    const record = JSON.parse(
      await readFile(join(f.uploads, doc.id + ".json"), "utf8"),
    );
    expect(record).toMatchObject({
      version: 3,
      delivery: "possible",
      fileName: name,
      path: file.path,
    });
    expect(record.path).not.toBe(join(f.uploads, doc.id + "-" + name));
  });

  it.each([
    ["研".repeat(71) + ".txt", 254],
    ["研".repeat(71) + "a.txt", 255],
    ["研".repeat(71) + "ab.txt", 255],
  ])(
    "handles the UTF-8 component boundary without changing readable metadata: %s",
    async (name, bytes) => {
      const f = await fixture(),
        doc = await f.store.add(upload(name as string));
      const { files } = await f.store.resolveForPrompt([doc.id]),
        path = files[0]!.path;
      expectPortable(path);
      expect(Buffer.byteLength(basename(path), "utf8")).toBe(bytes);
      expect(doc.fileName).toBe(name);
      expect(path.endsWith(".txt")).toBe(true);
      expect(await readFile(path, "utf8")).toBe("readable payload");
    },
  );

  it.each([
    "a".repeat(159) + "𝒜",
    "a" + "𝒜".repeat(79) + ".txt",
    "é".repeat(120) + ".pdf",
    "ΐ".repeat(100) + ".txt",
  ])(
    "bounds display and physical names without splitting Unicode points: %s",
    async (name) => {
      const f = await fixture(),
        doc = await f.store.add(upload(name));
      expect(doc.fileName.length).toBeLessThanOrEqual(160);
      expect(Buffer.from(doc.fileName).toString("utf8")).toBe(doc.fileName);
      const { files } = await f.store.resolveForPrompt([doc.id]);
      expectPortable(files[0]!.path);
      if (name.endsWith(".txt") || name.endsWith(".pdf"))
        expect(files[0]!.path.slice(-4)).toBe(name.slice(-4));
      await f.session(files[0]!.path);
      await f.store.releaseConsumed([doc.id]);
      await f.store.close();
      const reopened = f.open();
      await reopened.ready();
      expect(reopened.promptFileName(files[0]!.path)).toBe(doc.fileName);
    },
  );

  it.each(["cafe\u0301分析.txt", "report. ", "...", " ", "CON.txt", "NUL"])(
    "keeps readable Unicode/metadata but uses a Windows-compatible physical suffix: %s",
    async (name) => {
      const f = await fixture(),
        doc = await f.store.add(upload(name));
      expect(doc.fileName).toBe(name);
      const { files } = await f.store.resolveForPrompt([doc.id]);
      expectPortable(files[0]!.path);
      expect(await readFile(files[0]!.path, "utf8")).toBe("readable payload");
    },
  );

  it("keeps a byte-bounded delivered file recallable after restart and session deletion", async () => {
    const f = await fixture(),
      name = "文".repeat(100) + ".txt",
      doc = await f.store.add(upload(name));
    const { files } = await f.store.resolveForPrompt([doc.id]),
      path = files[0]!.path;
    const session = await f.session(path);
    await f.store.releaseConsumed([doc.id]);
    await f.store.close();
    await rm(session);
    const reopened = f.open();
    expect(await reopened.collectStaged()).toEqual({ reclaimed: [] });
    expect(reopened.ownsPromptFile(path)).toBe(true);
    expect(reopened.promptFileName(path)).toBe(name);
    expect(await readFile(path, "utf8")).toBe("readable payload");
  });

  it("keeps different uploads distinct when their readable physical suffixes truncate identically", async () => {
    const f = await fixture();
    const first = await f.store.add(upload("中".repeat(100) + ".txt", "first"));
    const second = await f.store.add(
      upload("中".repeat(99) + "文.txt", "second"),
    );
    const { files } = await f.store.resolveForPrompt([first.id, second.id]);
    expect(files[0]!.path).not.toBe(files[1]!.path);
    expect(basename(files[0]!.path).slice(37)).toBe(
      basename(files[1]!.path).slice(37),
    );
    expect(await readFile(files[0]!.path, "utf8")).toBe("first");
    expect(await readFile(files[1]!.path, "utf8")).toBe("second");
  });

  it("recalls an unversioned ownership record without migrating its path or deleting its asset", async () => {
    const f = await fixture(),
      doc = await f.store.add(upload("legacy.txt"));
    const { files } = await f.store.resolveForPrompt([doc.id]),
      path = files[0]!.path;
    await f.store.releaseConsumed([doc.id]);
    await f.store.close();
    const metadata = join(f.uploads, doc.id + ".json");
    const record = JSON.parse(await readFile(metadata, "utf8"));
    delete record.version;
    const legacy = JSON.stringify(record);
    await writeFile(metadata, legacy);
    const reopened = f.open();
    await reopened.ready();
    expect(await readFile(metadata, "utf8")).toBe(legacy);
    expect(reopened.promptFileName(path)).toBe("legacy.txt");
    expect(await reopened.collectStaged()).toEqual({ reclaimed: [] });
    expect(await readFile(path, "utf8")).toBe("readable payload");
  });

  it("validates legacy NTFS-length authority without applying the new UTF-8 rule or rewriting its reference", async () => {
    const f = await fixture(),
      id = randomUUID(),
      name = "字".repeat(100) + ".txt";
    await f.store.ready();
    await f.store.close();
    const path = join(f.uploads, id + "-" + name),
      metadata = join(f.uploads, id + ".json");
    const record = {
      id,
      fileName: name,
      kind: "file",
      mimeType: "text/plain",
      size: 6,
      path,
      ownerPid: 0,
    };
    const original = JSON.stringify(record);
    await writeFile(metadata, original);
    // NTFS permits this UTF-16 component; most POSIX fixture filesystems do not.
    // Validation itself must accept existing metadata on every Host platform.
    if (process.platform === "win32") await writeFile(path, "legacy");
    const reopened = f.open();
    await reopened.ready();
    expect(reopened.ownsPromptFile(path)).toBe(true);
    expect(reopened.promptFileName(path)).toBe(name);
    expect(await readFile(metadata, "utf8")).toBe(original);
    if (process.platform === "win32")
      expect(await readFile(path, "utf8")).toBe("legacy");
  });

  it.each(["unknown-version", "legacy-path-for-v2", "unowned-path"] as const)(
    "does not authorize recall or deletion from mismatched ownership: %s",
    async (kind) => {
      const f = await fixture(),
        doc = await f.store.add(upload("valid.txt"));
      const metadata = join(f.uploads, doc.id + ".json");
      const record = JSON.parse(await readFile(metadata, "utf8"));
      const unrelated = join(f.uploads, "user-file.txt");
      await writeFile(unrelated, "keep");
      const invalid =
        kind === "unknown-version"
          ? { ...record, version: 99 }
          : kind === "legacy-path-for-v2"
            ? {
                ...record,
                fileName: "字".repeat(100),
                path: join(f.uploads, doc.id + "-" + "字".repeat(100)),
              }
            : { ...record, path: unrelated };
      await writeFile(metadata, JSON.stringify(invalid));
      const reopened = f.open();
      await reopened.ready();
      expect(reopened.ownsPromptFile(record.path)).toBe(false);
      expect(await reopened.collectStaged()).toEqual({ reclaimed: [] });
      expect(await readFile(unrelated, "utf8")).toBe("keep");
      await writeFile(metadata, JSON.stringify(record));
    },
  );
});

it("uploads real browser-style UTF-8 FormData through staged disk storage without mojibake or ENAMETOOLONG", async () => {
  const host = await hostApiFixture();
  hosts.push(host);
  const form = new FormData(),
    names = ["研".repeat(100) + ".txt", "cafe\u0301.txt", "é.txt"];
  for (const name of names)
    form.append(
      "files",
      new Blob(["browser payload"], { type: "text/plain" }),
      name,
    );
  const response = await fetch(host.baseUrl + "/api/attachments", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: form,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    attachments: Array<{ id: string; fileName: string }>;
  };
  expect(body.attachments.map((file) => file.fileName)).toEqual(names);
  const { files } = await host.attachments.resolveForPrompt(
    body.attachments.map((file) => file.id),
  );
  for (const file of files) {
    expectPortable(file.path);
    expect(await readFile(file.path, "utf8")).toBe("browser payload");
  }
});
