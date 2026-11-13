import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { systemdRestartBackend } from "../../server/host-restart-systemd.js";
import {
  installSystemdManager,
  preparePackagedLauncher,
} from "../fixtures/packaged-launcher.mjs";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.runIf(process.platform === "linux").each([
  { includeHerdr: false, admit: true, stopFails: false },
  { includeHerdr: true, admit: true, stopFails: false },
  { includeHerdr: false, admit: false, stopFails: false },
  { includeHerdr: false, admit: true, stopFails: true },
])(
  "submits only after commit and Pi exit (Herdr=$includeHerdr, admitted=$admit, stop fails=$stopFails)",
  async ({ includeHerdr, admit, stopFails }) => {
    const root = await mkdtemp(join(tmpdir(), "inspire-global-restart-"));
    roots.push(root);
    await preparePackagedLauncher(root);
    const log = await installSystemdManager(root);
    for (const [key, value] of Object.entries({
      PATH: [
        join(root, "bin"),
        dirname(process.execPath),
        "/usr/bin",
        "/bin",
      ].join(delimiter),
      XDG_CONFIG_HOME: join(root, "config"),
      FIXTURE_ROOT: root,
      FIXTURE_LOG: log,
      INVOCATION_ID: "a".repeat(32),
    }))
      vi.stubEnv(key, value);
    const commit = vi.fn(() => admit);
    const stopPi = vi.fn(async (_options: { includeHerdr: boolean }) => {
      expect(commit).toHaveBeenCalledOnce();
      if (stopFails) throw new Error("PID fixture did not exit");
    });
    const backend = systemdRestartBackend(root, true, { includeHerdr, stopPi });
    expect(await backend.inspect()).toMatchObject({
      allPi: true,
      includeHerdr,
    });
    const issued = admit && !stopFails;
    expect(await backend.request("all-pi", commit)).toMatchObject({
      code: issued ? 0 : 1,
      issued,
      ...(stopFails
        ? { error: expect.stringContaining("PID fixture did not exit") }
        : {}),
    });
    if (admit) expect(stopPi).toHaveBeenCalledExactlyOnceWith({ includeHerdr });
    else expect(stopPi).not.toHaveBeenCalled();
    const restarts = (await readFile(log, "utf8"))
      .split("\n")
      .filter((line) => line.includes(" restart "));
    expect(restarts).toEqual(
      issued
        ? [
            "--user --no-block restart inspire-terminal.service inspire-host.service",
          ]
        : [],
    );
  },
);
