import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensurePrivateDirectory } from "../../server/private-directory.js";
import { replacePrivateStateFile } from "../../server/private-state-file.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "inspire-private-state-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe.runIf(process.platform !== "win32")(
  "private state directories",
  () => {
    it("creates a private directory and requires explicit permission repair", async () => {
      const path = join(directory, "parent", "state");
      const mode = async () => (await fs.lstat(path)).mode & 0o777;
      await ensurePrivateDirectory(path, "state directory");
      expect(await mode()).toBe(0o700);

      await fs.chmod(path, 0o755);
      await expect(
        ensurePrivateDirectory(path, "state directory"),
      ).rejects.toThrow("must not be accessible by other users");
      expect(await mode()).toBe(0o755);
      await ensurePrivateDirectory(path, "state directory", {
        loose: "repair",
      });
      expect(await mode()).toBe(0o700);
    });

    it("refuses an alias and leaves a missing directory absent during validation", async () => {
      const link = join(directory, "link");
      await fs.symlink(directory, link);
      await expect(
        ensurePrivateDirectory(link, "state directory"),
      ).rejects.toThrow("not a private directory");

      const missing = join(directory, "missing");
      await expect(
        ensurePrivateDirectory(missing, "state directory", { create: false }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);

describe("private state publication", () => {
  beforeEach(async () => {
    path = join(directory, "state.json");
    await fs.writeFile(path, "old state");
  });
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
