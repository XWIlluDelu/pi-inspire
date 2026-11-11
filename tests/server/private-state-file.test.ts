import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replacePrivateStateFile } from "../../server/private-state-file.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "inspire-private-state-"));
  path = join(directory, "state.json");
  await fs.writeFile(path, "old state");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("private state publication", () => {
  it("retains the previous file until publication and replaces it with private complete content", async () => {
    let markPrepared!: () => void;
    let allowPublish!: () => void;
    const prepared = new Promise<void>((resolve) => {
      markPrepared = resolve;
    });
    const publish = new Promise<void>((resolve) => {
      allowPublish = resolve;
    });
    const replacement = replacePrivateStateFile(path, '{"complete":true}\n', {
      beforeReplace: () => {
        markPrepared();
        return publish;
      },
    });
    await prepared;
    try {
      expect(await fs.readFile(path, "utf8")).toBe("old state");
    } finally {
      allowPublish();
      await replacement;
    }
    expect(await fs.readFile(path, "utf8")).toBe('{"complete":true}\n');
    expect(await fs.readdir(directory)).toEqual(["state.json"]);
    if (process.platform !== "win32")
      expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  });

  it("removes a partial temporary write without changing the published state", async () => {
    const writeFile = fs.writeFile;
    const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    vi.spyOn(fs, "writeFile").mockImplementationOnce(
      async (file, _data, options) => {
        await writeFile(file, "partial", options);
        throw failure;
      },
    );
    await expect(replacePrivateStateFile(path, "replacement")).rejects.toBe(
      failure,
    );
    expect(await fs.readFile(path, "utf8")).toBe("old state");
    expect(await fs.readdir(directory)).toEqual(["state.json"]);
  });

  it("reports the publication failure even when temporary cleanup also fails", async () => {
    const failure = new Error("publication denied");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(failure);
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup denied"));
    await expect(replacePrivateStateFile(path, "replacement")).rejects.toBe(
      failure,
    );
    expect(await fs.readFile(path, "utf8")).toBe("old state");
  });
});
