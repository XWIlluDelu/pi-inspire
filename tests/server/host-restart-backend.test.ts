import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { systemdRestartBackend } from "../../server/host-restart-backend.js";
import { prepareHostRestart } from "../../server/host-restart-preparation.js";
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

it("captures a bounded preflight error and allows a corrected retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "inspire-preflight-probe-"));
  roots.push(root);
  const launcher = join(root, "inspire.mjs");
  const backend = systemdRestartBackend(root, false);
  expect(await backend.inspect()).toEqual({ host: false });
  const commit = vi.fn(() => true);
  await expect(backend.request("host", commit)).resolves.toEqual({
    kind: "not-issued",
    reason: "unsupported",
  });
  expect(commit).not.toHaveBeenCalled();
  await writeFile(
    launcher,
    `console.error("x".repeat(10000)); console.error("\\x1b[31mSynthetic missing runtime module\\x1b[0m"); process.exitCode = 1;`,
  );
  const failure = await prepareHostRestart(root)
    .catch((error: Error) => error.message);
  expect(failure).toEqual(
    expect.stringContaining("Synthetic missing runtime module"),
  );
  expect(failure).not.toContain("\u001b");
  expect(failure?.length).toBeLessThan(4100);
  await writeFile(
    launcher,
    'if (process.argv[2] !== "prepare-restart") process.exit(1);',
  );
  await expect(prepareHostRestart(root)).resolves.toBeUndefined();
});

it.runIf(process.platform === "linux").each([
  { admit: true },
  { admit: false },
])(
  "submits systemd host restart only after commit (admitted=$admit)",
  async ({ admit }) => {
    const root = await mkdtemp(join(tmpdir(), "inspire-host-restart-"));
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
    const backend = systemdRestartBackend(root, true);
    expect(await backend.inspect()).toEqual({ host: true });
    expect(await backend.request("host", commit)).toMatchObject({
      kind: admit ? "issued" : "not-issued",
    });
    const restarts = (await readFile(log, "utf8"))
      .split("\n")
      .filter((line) => line.includes(" restart "));
    expect(restarts).toEqual(
      admit ? ["--user --no-block restart inspire-host.service"] : [],
    );
  },
);
