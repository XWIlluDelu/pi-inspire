import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiActivityRecord } from "../../extensions/inspire-session-bridge.js";
import { PiSessionOccupancy } from "../../server/pi-session-occupancy.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readdir: vi.fn(fs.readdir), rename: vi.fn(fs.rename) };
});

let root: string, directory: string, sessionFile: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inspire-session-occupancy-"));
  directory = join(root, "reports");
  sessionFile = join(root, "session.jsonl");
  await mkdir(directory);
  await writeFile(sessionFile, "");
});
afterEach(async () => rm(root, { recursive: true, force: true }));

async function report(overrides: Partial<PiActivityRecord> = {}) {
  const record: PiActivityRecord = {
    version: 1,
    pid: process.pid,
    processIdentity: "birth-one",
    sessionId: "session",
    sessionFile,
    activity: "idle",
    updatedAt: Date.now(),
    ...overrides,
  };
  const file = join(directory, `${record.pid}-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(record));
  return {
    file,
    update: async (changes: Partial<PiActivityRecord>) =>
      writeFile(file, JSON.stringify({ ...record, ...changes })),
  };
}
const active = { status: 409, code: "EXTERNAL_PI_WRITER_ACTIVE" };

describe("external Pi session presence at writer admission", () => {
  it("requires the same reporter, process birth and exact old/new files to prove a rebind", async () => {
    const r = await report();
    const birth = vi.fn(async () => "birth-one");
    const guard = new PiSessionOccupancy(directory, birth);
    const check = (await guard.observeBinding(
      process.pid,
      "session",
      sessionFile,
    ))!;
    const other = join(root, "other.jsonl");
    await writeFile(other, "");
    const target = { kind: "id" as const, value: "other" };
    await r.update({ sessionId: "other" }); // same file is not release
    expect(await check(target)).toBe(false);
    await r.update({
      sessionId: "other",
      sessionFile: other,
      processIdentity: "wrong-birth",
    });
    expect(await check(target)).toBe(false);
    await r.update({ inactive: true });
    expect(await check(target)).toBe(false);
    await rm(r.file);
    const otherProducer = await report({
      sessionId: "other",
      sessionFile: other,
    });
    expect(await check(target)).toBe(false);
    await r.update({ sessionId: "other", sessionFile: other });
    expect(await check({ kind: "id", value: "wrong-target" })).toBe(false);
    birth.mockResolvedValue("reused-pid");
    expect(await check(target)).toBe(false);
    birth.mockResolvedValue("birth-one");
    expect(await check(target)).toBe(true);
    expect(await check({ kind: "path", value: other })).toBe(true);
    await rm(r.file);
    await rm(otherProducer.file);
    for (const reader of [guard, new PiSessionOccupancy(directory, birth)]) {
      await expect(
        reader.assertWritable("session", sessionFile),
      ).resolves.toBeUndefined();
      await expect(reader.assertWritable("other", other)).rejects.toMatchObject(
        active,
      );
    }
  });

  it.each(["idle", "working", "blocked"] as const)(
    "fences a live %s holder even after activity expires and across Host reconstruction",
    async (activity) => {
      await report({ activity, updatedAt: Date.now() - 60_000 });
      for (let host = 0; host < 2; host++) {
        const guard = new PiSessionOccupancy(
          directory,
          async () => "birth-one",
        );
        await expect(
          guard.assertWritable("session", sessionFile),
        ).rejects.toMatchObject(active);
      }
    },
  );

  it("does not let overlapping admissions roll retained evidence back to an older binding", async () => {
    const r = await report();
    const otherFile = join(root, "other.jsonl");
    await writeFile(otherFile, "");
    const nativeRename = vi.mocked(rename).getMockImplementation()!;
    let continueCommit!: () => void, enteredCommit!: () => void;
    const proceed = new Promise<void>((resolve) => {
      continueCommit = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enteredCommit = resolve;
    });
    vi.mocked(rename).mockImplementationOnce(async (...args) => {
      enteredCommit();
      await proceed;
      return nativeRename(...args);
    });
    const guard = new PiSessionOccupancy(directory, async () => "birth-one");
    const outcome = (id: string, file: string) =>
      guard.assertWritable(id, file).then(
        () => null,
        (error: unknown) => error,
      );
    const first = outcome("session", sessionFile);
    let second: Promise<unknown> | undefined;
    try {
      await entered;
      await r.update({ sessionId: "other", sessionFile: otherFile });
      const readsBefore = vi.mocked(readdir).mock.calls.length;
      second = outcome("other", otherFile);
      await Promise.resolve();
      // If observations can overlap, settle the newer cache write before the
      // older paused rename. A serialized lane instead keeps this read queued.
      if (vi.mocked(readdir).mock.calls.length > readsBefore) await second;
    } finally {
      continueCommit();
      await Promise.all([first, second]);
    }
    expect(await first).toMatchObject(active);
    expect(await second).toMatchObject(active);
    await rm(r.file);
    await expect(
      new PiSessionOccupancy(directory, async () => "birth-one").assertWritable(
        "other",
        otherFile,
      ),
    ).rejects.toMatchObject(active);
  });

  it("retains a known holder through missing, malformed and unreadable reports", async () => {
    const r = await report();
    const guard = new PiSessionOccupancy(directory, async () => "birth-one");
    await expect(
      guard.assertWritable("session", sessionFile),
    ).rejects.toMatchObject(active);
    await writeFile(r.file, "{partial");
    await expect(
      guard.assertWritable("session", sessionFile),
    ).rejects.toMatchObject(active);
    await rm(directory, { recursive: true });
    await expect(
      guard.assertWritable("session", sessionFile),
    ).rejects.toMatchObject(active);
  });

  it("retains a missing source report across Host restart until completed rebind", async () => {
    const r = await report();
    await expect(
      new PiSessionOccupancy(directory, async () => "birth-one").assertWritable(
        "session",
        sessionFile,
      ),
    ).rejects.toMatchObject(active);
    await rm(r.file);
    const successor = new PiSessionOccupancy(
      directory,
      async () => "birth-one",
    );
    await expect(
      successor.assertWritable("session", sessionFile),
    ).rejects.toMatchObject(active);
    await r.update({ released: true });
    await expect(
      successor.assertWritable("session", sessionFile),
    ).rejects.toMatchObject(active);
    await r.update({
      sessionId: "other",
      sessionFile: join(root, "other.jsonl"),
    });
    await expect(
      successor.assertWritable("session", sessionFile),
    ).resolves.toBeUndefined();
    await expect(
      new PiSessionOccupancy(directory, async () => "birth-one").assertWritable(
        "session",
        sessionFile,
      ),
    ).resolves.toBeUndefined();
  });

  it("persists an explicit rebind before a later report loss and Host restart", async () => {
    const r = await report();
    const other = join(root, "other.jsonl");
    await writeFile(other, "");
    const guard = new PiSessionOccupancy(directory, async () => "birth-one");
    await expect(
      guard.assertWritable("session", sessionFile),
    ).rejects.toMatchObject(active);
    await r.update({ sessionId: "other", sessionFile: other });
    await expect(
      guard.assertWritable("session", sessionFile),
    ).resolves.toBeUndefined();
    await rm(r.file);
    const successor = new PiSessionOccupancy(
      directory,
      async () => "birth-one",
    );
    await expect(
      successor.assertWritable("session", sessionFile),
    ).resolves.toBeUndefined();
    await expect(
      successor.assertWritable("other", other),
    ).rejects.toMatchObject(active);
  });

  it("does not trust activity stop hints but permits a completed rebind", async () => {
    const r = await report({ activity: "working" });
    const guard = new PiSessionOccupancy(directory, async () => "birth-one");
    await expect(
      guard.assertWritable("session", sessionFile),
    ).rejects.toMatchObject(active);
    await r.update({ activity: "idle" });
    await expect(
      guard.assertWritable("session", sessionFile),
    ).rejects.toMatchObject(active);
    await r.update({ inactive: true });
    await expect(
      guard.assertWritable("session", sessionFile),
    ).rejects.toMatchObject(active);
    await r.update({ released: true });
    await expect(
      guard.assertWritable("session", sessionFile),
    ).rejects.toMatchObject(active);
    await r.update({
      sessionId: "other",
      sessionFile: join(root, "other.jsonl"),
    });
    await expect(
      guard.assertWritable("session", sessionFile),
    ).resolves.toBeUndefined();
  });

  it.each([true, false])(
    "fences a legacy released record on first observation (birth metadata: %s)",
    async (birth) => {
      await report({
        released: true,
        processIdentity: birth ? "birth-one" : undefined,
      });
      await expect(
        new PiSessionOccupancy(
          directory,
          async () => "birth-one",
        ).assertWritable("session", sessionFile),
      ).rejects.toMatchObject(active);
    },
  );

  it("checks process birth and does not let a recycled PID inherit an old claim", async () => {
    const r = await report();
    let birth = "birth-one";
    const guard = new PiSessionOccupancy(directory, async () => birth);
    await expect(
      guard.assertWritable("session", sessionFile),
    ).rejects.toMatchObject(active);
    await rm(r.file);
    birth = "birth-two";
    await expect(
      guard.assertWritable("session", sessionFile),
    ).resolves.toBeUndefined();
    await report(); // stale on-disk claim from the old incarnation
    await expect(
      new PiSessionOccupancy(directory, async () => birth).assertWritable(
        "session",
        sessionFile,
      ),
    ).resolves.toBeUndefined();
  });

  it.each([undefined, "ENOENT", "EACCES"])(
    "keeps a live holder fenced when native metadata fails (%s)",
    async (code) => {
      await report();
      const identity = vi.fn(async (): Promise<string> => {
        throw Object.assign(new Error("Native metadata unavailable"), { code });
      });
      await expect(
        new PiSessionOccupancy(directory, identity).assertWritable(
          "session",
          sessionFile,
        ),
      ).rejects.toMatchObject(active);
    },
  );

  it("allows a confirmed dead process but accepts legacy reports conservatively", async () => {
    await report({ pid: 2_147_483_647, inactive: true, released: true });
    const guard = new PiSessionOccupancy(directory, async () => "birth-one");
    await expect(
      guard.assertWritable("session", sessionFile),
    ).resolves.toBeUndefined();
    await report({
      processIdentity: undefined,
      updatedAt: Date.now() - 60_000,
    });
    await expect(
      guard.assertWritable("session", sessionFile),
    ).rejects.toMatchObject(active);
  });

  it("matches native identity and physical path without trusting arbitrary report content", async () => {
    const r = await report({ sessionId: "other" });
    const guard = new PiSessionOccupancy(directory, async () => "birth-one");
    await expect(
      guard.assertWritable("session", sessionFile),
    ).resolves.toBeUndefined();
    await r.update({ sessionFile: join(root, "wrong.jsonl") });
    await expect(
      guard.assertWritable("session", sessionFile),
    ).resolves.toBeUndefined();
    await r.update({ sessionId: "session", sessionFile });
    await expect(
      guard.assertWritable("session", sessionFile),
    ).rejects.toMatchObject(active);
  });

  it.skipIf(process.platform === "win32")(
    "recognizes a session reached through a symlink alias",
    async () => {
      const alias = join(root, "alias.jsonl");
      await symlink(sessionFile, alias);
      await report({ sessionFile: alias });
      await expect(
        new PiSessionOccupancy(
          directory,
          async () => "birth-one",
        ).assertWritable("session", sessionFile),
      ).rejects.toMatchObject(active);
    },
  );

  it("does not treat a failed directory inspection as permission to launch", async () => {
    await rm(directory, { recursive: true });
    await writeFile(directory, "not a directory");
    await expect(
      new PiSessionOccupancy(directory).assertWritable("session", sessionFile),
    ).rejects.toMatchObject({
      status: 409,
      code: "SESSION_OWNER_UNAVAILABLE",
    });
    expect(await readFile(directory, "utf8")).toBe("not a directory");
  });
});
