import { appendFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { nativePiWorkspace } from "./fixtures/native-pi.js";

it("reads native usage totals and keeps the worker cursor separate from another writer's tail", async () => {
  const { root, cwd, sessions, env } = await nativePiWorkspace(
    "inspire-native-stats-",
    { defaultProjectTrust: "never" },
  );
  const path = join(root, "source.jsonl");
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const timestamp = "2026-08-01T00:00:00.000Z";
  const usage = (
    id: string,
    parentId: string,
    kind: string,
    tokens: number,
  ) => ({
    type: "usage",
    id,
    parentId,
    timestamp,
    kind,
    provider: "fixture",
    model: "offline",
    usage: {
      input: 0,
      output: 0,
      cacheRead: tokens,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: {
        input: 0,
        output: 0,
        cacheRead: tokens / 8_000,
        cacheWrite: 0,
        total: tokens / 8_000,
      },
    },
  });
  const rpc = new PiRpcProcess({
    cwd,
    args: ["--no-extensions", "--session-dir", sessions, "--session", path],
    env,
  });
  try {
    const entries = [
      { type: "session", version: 3, id: sessionId, timestamp, cwd },
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp,
        message: { role: "user", content: "Existing session", timestamp: 0 },
      },
      usage("cache", "user", "cache_warm", 1_000),
      usage("worker-tail", "cache", "future-usage-kind", 2_000),
    ];
    await writeFile(
      path,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    await rpc.start();
    await expect(
      rpc.request({ type: "get_session_stats" }),
    ).resolves.toMatchObject({
      sessionId,
      tokens: { cacheRead: 3_000, total: 3_000 },
      cost: 0.375,
    });
    const { leafId } = await rpc.request<{ leafId: string | null }>({
      type: "get_entries",
    });
    expect(leafId).toBeTruthy();

    const external = {
      type: "custom",
      id: "disk-tail",
      parentId: leafId,
      timestamp,
      customType: "external",
      data: {},
    };
    await appendFile(path, `${JSON.stringify(external)}\n`);
    // A Host following a foreign append still has to read with the worker's
    // last known cursor. The newly persisted tail is absent from this Pi.
    await expect(
      rpc.request({ type: "get_entries", since: leafId }),
    ).resolves.toEqual({ entries: [], leafId });
    await expect(
      rpc.request({ type: "get_entries", since: external.id }),
    ).rejects.toThrow(/not found/i);
  } finally {
    await rpc.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
