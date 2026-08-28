import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discardStagedSessionFork,
  publishStagedSessionFork,
  stageSessionFork,
} from "../../server/session-fork.js";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const directories: string[] = [];

const entry = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  content: string,
  timestamp: number,
) => ({
  type: "message",
  id,
  parentId,
  timestamp: new Date(timestamp).toISOString(),
  message: { role, content, timestamp },
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inspire-session-fork-"));
  directories.push(directory);
  const sourcePath = join(directory, "source.jsonl");
  const source = [
    {
      type: "session",
      version: 3,
      id: SOURCE_ID,
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: directory,
    },
    entry("u1", null, "user", "root", 1),
    entry("a1", "u1", "assistant", "first answer", 2),
    entry("u2", "a1", "user", "edit this", 3),
    entry("a2", "u2", "assistant", "second answer", 4),
  ];
  const bytes = Buffer.from(
    `${source.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  await writeFile(sourcePath, bytes);
  return {
    directory,
    sourcePath,
    bytes,
    request: {
      sourcePath,
      sourceSessionId: SOURCE_ID,
      targetId: "u2",
      targetParentId: "a1",
      sourceCommittedBytes: bytes.length,
      sourceFingerprint: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("independent session fork", () => {
  it("creates and atomically publishes a Pi-native branch without writing the source", async () => {
    const { sourcePath, bytes, request } = await fixture();
    const staged = await stageSessionFork(request);
    const stagedLines = (await readFile(staged.stagedPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(await readFile(sourcePath)).toEqual(bytes);
    expect(stagedLines[0]).toMatchObject({
      type: "session",
      id: staged.destinationId,
      cwd: staged.cwd,
      parentSession: sourcePath,
    });
    expect(stagedLines.slice(1).map((line) => line.id)).toEqual(["u1", "a1"]);
    expect(stagedLines.some((line) => line.id === "u2")).toBe(false);

    const stagedBytes = await readFile(staged.stagedPath);
    await publishStagedSessionFork(staged);
    expect(await readFile(staged.destinationPath)).toEqual(stagedBytes);
    expect(await readFile(staged.destinationPath, "utf8")).toContain(
      `"id":"${staged.destinationId}"`,
    );
    expect(await readFile(sourcePath)).toEqual(bytes);
  });

  it("accepts source-only appends and an in-progress trailing write beyond the admitted prefix", async () => {
    const { sourcePath, request } = await fixture();
    const appended = `${JSON.stringify(
      entry("later", "a2", "assistant", "still running", 5),
    )}\n{"type":"message"`;
    await appendFile(sourcePath, appended);
    const sourceAtFork = await readFile(sourcePath);

    const staged = await stageSessionFork(request);
    expect(await readFile(sourcePath)).toEqual(sourceAtFork);
    expect(await readFile(staged.stagedPath, "utf8")).not.toContain(
      '"id":"later"',
    );
    await discardStagedSessionFork(staged);
  });

  it("materializes Pi's deferred header-only fork before the first user message", async () => {
    const { sourcePath, request } = await fixture();
    const staged = await stageSessionFork({
      ...request,
      targetId: "u1",
      targetParentId: null,
    });
    const lines = (await readFile(staged.stagedPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: "session",
      id: staged.destinationId,
      parentSession: sourcePath,
    });
    await discardStagedSessionFork(staged);
  });

  it("rejects a rewritten admitted prefix and removes private staging", async () => {
    const { directory, sourcePath, request } = await fixture();
    const rewritten = (await readFile(sourcePath, "utf8")).replace(
      "first answer",
      "other answer",
    );
    await writeFile(sourcePath, rewritten);

    await expect(stageSessionFork(request)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("changed before its fork boundary"),
    });
    expect((await readdir(directory)).sort()).toEqual(["source.jsonl"]);
  });

  it("fails an atomic publication collision without replacing the existing path", async () => {
    const { request } = await fixture();
    const staged = await stageSessionFork(request);
    await writeFile(staged.destinationPath, "existing\n");

    await expect(publishStagedSessionFork(staged)).rejects.toMatchObject({
      status: 409,
    });
    expect(await readFile(staged.destinationPath, "utf8")).toBe("existing\n");
    await discardStagedSessionFork(staged);
  });
});
