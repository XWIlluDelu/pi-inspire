import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultStaticAssetCacheDirectory,
  prepareStaticAssetCache,
} from "../../server/static-asset-cache.mjs";

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inspire-static-assets-"));
  temporaryDirectories.push(root);
  const source = join(root, "source");
  const cache = join(root, "cache");
  await mkdir(source, { recursive: true });
  return { source, cache };
}

async function replaceSource(
  source: string,
  files: Record<string, string>,
): Promise<void> {
  await rm(source, { recursive: true, force: true });
  await mkdir(source, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(source, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("static asset generation cache", () => {
  it("uses one stable cache location per installation root", () => {
    const options = {
      platform: "linux" as const,
      environment: { XDG_CACHE_HOME: "/cache" },
      home: "/home/test",
    };
    const first = defaultStaticAssetCacheDirectory("/srv/inspire", options);
    expect(defaultStaticAssetCacheDirectory("/srv/inspire", options)).toBe(
      first,
    );
    expect(defaultStaticAssetCacheDirectory("/srv/other", options)).not.toBe(
      first,
    );
    expect(basename(first)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("retains complete recent generations and expires them as units", async () => {
    const { source, cache } = await fixture();
    const now = Date.UTC(2026, 8, 4, 2);
    await replaceSource(source, {
      "ContextPane-first.js": "first context\n",
      "nested/common-first.css": "first css\n",
      "ignored.png": "image\n",
    });
    const first = await prepareStaticAssetCache(source, cache, { now });

    await replaceSource(source, {
      "ContextPane-second.js": "second context\n",
    });
    const second = await prepareStaticAssetCache(source, cache, {
      // The outgoing generation remains eligible from replacement time even
      // after a long uninterrupted period as the active build.
      now: now + 10_000,
      retentionMs: 1_000,
    });

    expect(second).toMatchObject({
      staleGenerations: 1,
      staleBytes:
        Buffer.byteLength("first context\n") + Buffer.byteLength("first css\n"),
      removedGenerations: 0,
      pruneFailures: 0,
    });
    const firstDirectory = join(cache, "generations", first.currentGeneration);
    await expect(
      readFile(join(firstDirectory, "ContextPane-first.js"), "utf8"),
    ).resolves.toBe("first context\n");
    await expect(
      readFile(join(firstDirectory, "nested", "common-first.css"), "utf8"),
    ).resolves.toBe("first css\n");
    await expect(
      stat(join(firstDirectory, "ignored.png")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const expired = await prepareStaticAssetCache(source, cache, {
      now: now + 12_000,
      retentionMs: 1_000,
    });
    expect(expired).toMatchObject({
      staleGenerations: 0,
      staleBytes: 0,
      removedGenerations: 1,
      pruneFailures: 0,
    });
    await expect(stat(firstDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the newest whole generation within the stale byte budget", async () => {
    const { source, cache } = await fixture();
    const now = Date.UTC(2026, 8, 4, 2);
    await replaceSource(source, {
      "old-entry.js": "123456\n",
      "old-shared.js": "123456\n",
    });
    const oldest = await prepareStaticAssetCache(source, cache, { now });

    await replaceSource(source, { "newer-entry.js": "1234567\n" });
    const newer = await prepareStaticAssetCache(source, cache, {
      now: now + 100,
    });

    await replaceSource(source, { "current.js": "current\n" });
    const current = await prepareStaticAssetCache(source, cache, {
      now: now + 200,
      maxStaleBytes: Buffer.byteLength("1234567\n"),
    });

    expect(current).toMatchObject({
      staleGenerations: 1,
      staleBytes: Buffer.byteLength("1234567\n"),
      removedGenerations: 1,
      pruneFailures: 0,
    });
    expect(current.generationDirectories).toContain(
      join(cache, "generations", newer.currentGeneration),
    );
    await expect(
      readFile(
        join(cache, "generations", newer.currentGeneration, "newer-entry.js"),
        "utf8",
      ),
    ).resolves.toBe("1234567\n");
    await expect(
      stat(join(cache, "generations", oldest.currentGeneration)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
