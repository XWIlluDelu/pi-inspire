import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GeneratedExportStore } from "../../server/generated-exports.js";
import { openCanonicalResourceFile } from "../../server/resources.js";

vi.mock("../../server/resources.js", { spy: true });
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.unstubAllEnvs();
});

it("keeps graphical exports as managed downloads and cleans temporary source files on success or failure", async () => {
  const store = new GeneratedExportStore();
  cleanup.push(() => store.close());
  let source = "";
  const result = await store.create("session", "jsonl", async (path) => {
    source = path;
    await writeFile(path, "branch\n");
  });
  const generated = await store.get("session", result.downloadId);
  expect(await readFile(generated.path, "utf8")).toBe("branch\n");
  await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    store.create("session", "html", async (path) => {
      source = path;
      await writeFile(path, "partial");
      throw new Error("Export failed");
    }),
  ).rejects.toThrow("Export failed");
  await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });
});

it("recovers from transient directory creation failure without acquiring/leaking a source handle", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "inspire-export-directory-test-"),
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "branch.jsonl");
  await writeFile(source, "snapshot\n");
  const temporary = join(directory, "unavailable");
  for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, temporary);
  expect(tmpdir()).toBe(temporary);
  const store = new GeneratedExportStore();
  cleanup.push(() => store.close());
  const openSource = vi.mocked(openCanonicalResourceFile);

  await expect(store.add("session", source, "jsonl")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(openSource).not.toHaveBeenCalled();
  // Repair the same directory and retry the same store, not a new instance.
  await mkdir(temporary);
  const result = await store.add("session", source, "jsonl");
  expect(openSource).toHaveBeenCalledTimes(1);
  const opened = await openSource.mock.results[0]!.value;
  expect(opened.handle.fd).toBe(-1);
  const generated = await store.get("session", result.downloadId);
  expect(await readFile(generated.path, "utf8")).toBe("snapshot\n");
  expect(result.fileName).toBe("branch.jsonl");
});
