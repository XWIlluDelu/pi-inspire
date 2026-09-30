import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProjection } from "../../server/session-projection.js";

vi.mock("node:fs/promises", async (original) => {
  const module = await original<typeof import("node:fs/promises")>();
  return { ...module, open: vi.fn(module.open) };
});

const fixtures: Array<{ directory: string; projection: SessionProjection }> =
  [];
const user = (id: string, parentId: string | null, content: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-08-01T00:00:00.000Z",
  message: { role: "user", content, timestamp: 1 },
});

async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), "inspire-read-reuse-"));
  const path = join(directory, "session.jsonl");
  const lines = [
    {
      type: "session",
      version: 3,
      id: "read-reuse",
      cwd: directory,
      timestamp: "2026-08-01T00:00:00.000Z",
    },
    user("u1", null, "before"),
  ];
  const bytes = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  await fs.writeFile(path, bytes);
  const projection = await SessionProjection.open({
    id: "read-reuse",
    path,
    source: null,
    cwd: directory,
    created: new Date(0),
    modified: new Date(0),
    messageCount: 1,
    firstMessage: "before",
    searchText: "before",
  });
  fixtures.push({ directory, projection });
  // Keep filesystem hints from consuming the observation under test.
  await projection.suspendReconciliation();
  vi.mocked(fs.open).mockClear();
  return { directory, path, bytes, projection };
}

afterEach(async () => {
  vi.mocked(fs.open).mockClear();
  for (const { directory, projection } of fixtures.splice(0)) {
    await projection.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("verified projection read reuse", () => {
  it("does not reopen unchanged healthy bytes, but explicit verification still does", async () => {
    const { projection } = await fixture();
    const revision = projection.revision;
    const fingerprint = projection.fingerprint;
    for (let index = 0; index < 3; index += 1) {
      await expect(projection.reconcileSuspended()).resolves.toMatchObject({
        changed: false,
        sourceChanged: false,
        revision,
        fingerprint,
      });
    }
    expect(fs.open).not.toHaveBeenCalled();
    await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
      changed: false,
      sourceChanged: false,
      verifiedUnchangedContent: true,
    });
    expect(fs.open).toHaveBeenCalledOnce();
  });

  it("revalidates a same-size edit even when the modification time is restored", async () => {
    const { path, bytes, projection } = await fixture();
    const before = await fs.stat(path);
    await fs.writeFile(path, bytes.replace("before", "edited"));
    await fs.utimes(path, before.atime, before.mtime);
    await expect(projection.reconcileSuspended()).resolves.toMatchObject({
      changed: true,
      kind: "rewrite",
      health: { status: "ok" },
    });
    expect(projection.messages[0]).toMatchObject({ content: "edited" });
    expect(fs.open).toHaveBeenCalled();
  });

  it("does not trust an unowned append to preserve the prior prefix", async () => {
    const { path, bytes, projection } = await fixture();
    await fs.writeFile(path, bytes.replace("before", "edited"));
    await fs.appendFile(path, `${JSON.stringify(user("u2", "u1", "after"))}\n`);
    await expect(projection.reconcileSuspended()).resolves.toMatchObject({
      changed: true,
      kind: "rewrite",
      health: { status: "ok" },
    });
    expect(projection.messages).toMatchObject([
      { content: "edited" },
      { content: "after" },
    ]);
  });

  it("recognizes an identical-byte replacement as a different source", async () => {
    const { directory, path, bytes, projection } = await fixture();
    const replacement = join(directory, "replacement.jsonl");
    await fs.writeFile(replacement, bytes);
    await fs.rename(replacement, path);
    const result = await projection.reconcileSuspended();
    expect(result).toMatchObject({ changed: false, sourceChanged: true });
    expect(result.verifiedUnchangedContent).toBeUndefined();
    expect(fs.open).toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a replacement symlink even when it points to the old file",
    async () => {
      const { directory, path, projection } = await fixture();
      const retained = join(directory, "retained.jsonl");
      await fs.rename(path, retained);
      await fs.symlink(retained, path);
      await expect(projection.reconcileSuspended()).resolves.toMatchObject({
        changed: false,
        health: { status: "error" },
      });
      expect(projection.messages[0]).toMatchObject({ content: "before" });
    },
  );

  it("revalidates unhealthy state even when the source metadata has not changed", async () => {
    const { projection } = await fixture();
    vi.mocked(fs.open).mockRejectedValueOnce(
      new Error("temporary read failure"),
    );
    await expect(projection.reconcileSuspended(true)).resolves.toMatchObject({
      health: { status: "error" },
    });
    vi.mocked(fs.open).mockClear();
    await expect(projection.reconcileSuspended()).resolves.toMatchObject({
      changed: false,
      healthChanged: true,
      health: { status: "ok" },
    });
    expect(fs.open).toHaveBeenCalledOnce();
  });
});
