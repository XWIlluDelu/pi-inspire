import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDiagnosticLogger } from "../../server/diagnostics.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function privateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inspire-diagnostics-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

describe("diagnostic logging", () => {
  it("writes bounded JSONL with private permissions and redacts content-bearing fields", async () => {
    const directory = await privateDirectory();
    const path = join(directory, "runtime.jsonl");
    const logger = await openDiagnosticLogger({
      path,
      hostId: "host-test",
      base: { processId: 42, token: "must-not-appear" },
    });

    logger.record("warning", "projection_conflict", {
      sessionId: "session-a",
      incidentId: "inc_test",
      prompt: "private prompt",
      apiToken: "private token",
      authorizationHeader: "private authorization",
      nested: { payload: "private extension payload", revision: 7 },
      oversized: "x".repeat(2_000),
    });
    await logger.close();

    const directoryMode = (await stat(directory)).mode & 0o777;
    const fileMode = (await stat(path)).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    const line = JSON.parse((await readFile(path, "utf8")).trim()) as Record<
      string,
      unknown
    >;
    expect(line).toMatchObject({
      level: "warning",
      event: "projection_conflict",
      hostId: "host-test",
      processId: 42,
      sessionId: "session-a",
      incidentId: "inc_test",
      prompt: "[redacted]",
      apiToken: "[redacted]",
      authorizationHeader: "[redacted]",
      nested: { payload: "[redacted]", revision: 7 },
    });
    expect(JSON.stringify(line)).not.toContain("private prompt");
    expect(JSON.stringify(line)).not.toContain("private token");
    expect(JSON.stringify(line)).not.toContain("private authorization");
    expect(JSON.stringify(line)).not.toContain("private extension payload");
    expect(JSON.stringify(line)).not.toContain("must-not-appear");
    expect(String(line.oversized).length).toBeLessThan(600);
  });

  it("rotates at the configured bound and retains only the requested generations", async () => {
    const directory = await privateDirectory();
    const path = join(directory, "runtime.jsonl");
    const logger = await openDiagnosticLogger({
      path,
      maxBytes: 64 * 1024,
      retainedFiles: 2,
    });
    for (let index = 0; index < 900; index += 1) {
      logger.record("info", "sample", {
        index,
        fingerprint: `sha256:${"a".repeat(80)}`,
      });
    }
    await logger.close();

    expect((await stat(path)).size).toBeLessThanOrEqual(66 * 1024);
    expect((await stat(`${path}.1`)).isFile()).toBe(true);
    expect((await stat(`${path}.2`)).isFile()).toBe(true);
    await expect(stat(`${path}.3`)).rejects.toMatchObject({ code: "ENOENT" });
    for (const candidate of [path, `${path}.1`, `${path}.2`]) {
      for (const line of (await readFile(candidate, "utf8"))
        .trim()
        .split("\n")) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it("refuses a symlink log target", async () => {
    const directory = await privateDirectory();
    const target = join(directory, "target.jsonl");
    const link = join(directory, "runtime.jsonl");
    await writeFile(target, "");
    await symlink(target, link);
    await expect(openDiagnosticLogger({ path: link })).rejects.toThrow(
      /regular file|symlink|symbolic links/i,
    );
  });
});
