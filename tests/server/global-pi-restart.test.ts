import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemdRestartBackend } from "../../server/host-restart-systemd.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(includeHerdr = false) {
  const root = await mkdtemp(join(tmpdir(), "inspire-global-restart-"));
  directories.push(root);
  await mkdir(join(root, "deploy/systemd"), { recursive: true });
  await writeFile(
    join(root, "deploy/systemd/control.mjs"),
    `
    export async function inspectBrowserRestart() { return { kind: "managed" }; }
    export async function requestBrowserRestart(_root, all, commit) {
      if (!all) throw new Error("Expected terminal-service restart");
      return await commit() ? { code: 0, issued: true } : { code: 1, issued: false };
    }
  `,
  );
  vi.stubEnv("INVOCATION_ID", "a".repeat(32));
  const stopPi = vi.fn(async (_options: { includeHerdr: boolean }) => {});
  const backend = systemdRestartBackend(root, true, { includeHerdr, stopPi });
  return { backend, stopPi };
}

describe.runIf(process.platform === "linux")(
  "global Pi restart submission",
  () => {
    it.each([false, true])(
      "uses the active Herdr mode (%s) after committing restart authority",
      async (includeHerdr) => {
        const { backend, stopPi } = await fixture(includeHerdr);
        expect(await backend.inspect()).toMatchObject({
          allPi: true,
          includeHerdr,
        });
        const commit = vi.fn(() => true);
        stopPi.mockImplementation(async () => {
          expect(commit).toHaveBeenCalledOnce();
        });
        await expect(backend.request("all-pi", commit)).resolves.toEqual({
          code: 0,
          issued: true,
        });
        expect(stopPi).toHaveBeenCalledExactlyOnceWith({ includeHerdr });
      },
    );

    it("does not discover or stop Pi after a rejected commit", async () => {
      const { backend, stopPi } = await fixture();
      await expect(backend.request("all-pi", () => false)).resolves.toEqual({
        code: 1,
        issued: false,
      });
      expect(stopPi).not.toHaveBeenCalled();
    });

    it("does not expand an older client's terminal restart into global Pi termination", async () => {
      const { backend, stopPi } = await fixture(true);
      await expect(backend.request("all", () => true)).resolves.toEqual({
        code: 0,
        issued: true,
      });
      expect(stopPi).not.toHaveBeenCalled();
    });

    it("reports failed Pi shutdown without issuing a restart", async () => {
      const { backend, stopPi } = await fixture();
      stopPi.mockRejectedValue(new Error("PID fixture did not exit"));
      await expect(
        backend.request("all-pi", () => true),
      ).resolves.toMatchObject({
        code: 1,
        issued: false,
        error: expect.stringContaining(
          "Pi shutdown failed. Inspire was not restarted.",
        ),
      });
    });
  },
);
