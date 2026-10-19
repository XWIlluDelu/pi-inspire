import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePiInstallation } from "../../server/pi-installation.js";

const directories: string[] = [];

async function fakePi(
  parent: string,
  version: string,
  entryDirectory = "dist",
) {
  const packageRoot = join(
    parent,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const binDirectory = join(parent, "bin");
  await Promise.all([
    mkdir(join(packageRoot, entryDirectory), { recursive: true }),
    mkdir(binDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version,
      type: "module",
      bin: { pi: `${entryDirectory}/cli.js` },
      exports: { ".": { import: `./${entryDirectory}/index.js` } },
    })}\n`,
  );
  await writeFile(
    join(packageRoot, entryDirectory, "index.js"),
    "export const marker = true;\n",
  );
  await writeFile(
    join(packageRoot, entryDirectory, "cli.js"),
    "#!/usr/bin/env node\n",
    { mode: 0o755 },
  );
  const commandPath = join(
    binDirectory,
    process.platform === "win32" ? "pi.cmd" : "pi",
  );
  if (process.platform === "win32") {
    await writeFile(commandPath, "@echo off\r\n", { mode: 0o755 });
  } else {
    await symlink(join(packageRoot, entryDirectory, "cli.js"), commandPath);
    await chmod(commandPath, 0o755);
  }
  return {
    packageRoot: await realpath(packageRoot),
    binDirectory,
    commandPath,
  };
}

for (const entry of ["CLI", "SDK"])
  it(`rejects a ${entry} entry in an actual case-distinct package sibling`, async (test) => {
    const temporary = await realpath(
      await mkdtemp(join(tmpdir(), "inspire-pi-boundary-")),
    );
    directories.push(temporary);
    const fixture = await fakePi(temporary, "1.0.0");
    const parent = dirname(fixture.packageRoot);
    if (process.platform === "win32") {
      const fsutil = process.env.SystemRoot
        ? join(process.env.SystemRoot, "System32", "fsutil.exe")
        : "fsutil.exe";
      try {
        await promisify(execFileCallback)(
          fsutil,
          ["file", "setCaseSensitiveInfo", parent, "enable"],
          { windowsHide: true, timeout: 10_000 },
        );
      } catch {
        return test.skip();
      }
    }
    const sibling = join(parent, "PI-CODING-AGENT");
    if (
      await stat(sibling).then(
        () => true,
        () => false,
      )
    )
      return test.skip();
    await mkdir(sibling);
    const manifestPath = join(fixture.packageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (entry === "CLI") manifest.bin.pi = "../PI-CODING-AGENT/cli.js";
    else manifest.exports["."].import = "../PI-CODING-AGENT/index.js";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(
      resolvePiInstallation({ command: fixture.commandPath }),
    ).rejects.toThrow(
      entry === "CLI" ? "invalid pi CLI entry" : "invalid Pi SDK entry",
    );
  });

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Pi installation authority", () => {
  it("loads the SDK and RPC CLI from one explicit Pi package without version gating", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-pi-installation-"));
    directories.push(directory);
    const pi = await fakePi(directory, "99.0.0");

    const installation = await resolvePiInstallation({
      command: pi.commandPath,
      installationRoot: join(directory, "inspire"),
    });

    expect(installation).toMatchObject({
      commandPath: pi.commandPath,
      packageRoot: pi.packageRoot,
      version: "99.0.0",
    });
    expect(installation.cliPath).toBe(join(pi.packageRoot, "dist/cli.js"));
    expect((installation.sdk as unknown as { marker: boolean }).marker).toBe(
      true,
    );
  });

  it("accepts valid package entries whose names begin with two dots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-pi-dot-entry-"));
    directories.push(directory);
    const pi = await fakePi(directory, "99.0.0", "..runtime");

    const installation = await resolvePiInstallation({
      command: pi.commandPath,
      installationRoot: join(directory, "inspire"),
    });

    expect(installation.cliPath).toBe(
      join(pi.packageRoot, "..runtime", "cli.js"),
    );
    expect(installation.sdkEntryPath).toBe(
      join(pi.packageRoot, "..runtime", "index.js"),
    );
    expect((installation.sdk as unknown as { marker: boolean }).marker).toBe(
      true,
    );
  });

  it("skips the checkout dependency and selects the separately installed Pi", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-pi-authority-"));
    directories.push(directory);
    const checkout = join(directory, "inspire");
    const local = await fakePi(checkout, "0.1.0");
    const external = await fakePi(join(directory, "global"), "2.0.0");

    const configuredCommand = process.env.INSPIRE_PI_COMMAND;
    delete process.env.INSPIRE_PI_COMMAND;
    try {
      const installation = await resolvePiInstallation({
        installationRoot: checkout,
        path: [local.binDirectory, external.binDirectory].join(delimiter),
      });

      expect(installation.packageRoot).toBe(external.packageRoot);
      expect(installation.version).toBe("2.0.0");
    } finally {
      if (configuredCommand === undefined)
        delete process.env.INSPIRE_PI_COMMAND;
      else process.env.INSPIRE_PI_COMMAND = configuredCommand;
    }
  });

  it.runIf(process.platform === "win32")(
    "resolves an npm-style shim from a quoted PATH directory containing spaces and semicolons",
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "inspire-pi-quoted-path-"),
      );
      directories.push(directory);
      const pi = await fakePi(
        join(directory, "Program Files;Research"),
        "3.0.0",
      );
      const installation = await resolvePiInstallation({
        command: "pi",
        path: '"' + pi.binDirectory + '"',
        installationRoot: join(directory, "inspire"),
      });
      expect(installation.commandPath).toBe(pi.commandPath);
      expect(installation.packageRoot).toBe(pi.packageRoot);
    },
  );

  it.runIf(process.platform === "win32")(
    "resolves an npm-style pi.cmd shim beside the external package",
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "inspire-pi-windows-shim-"),
      );
      directories.push(directory);
      const pi = await fakePi(directory, "3.0.0");

      const configuredCommand = process.env.INSPIRE_PI_COMMAND;
      delete process.env.INSPIRE_PI_COMMAND;
      try {
        const installation = await resolvePiInstallation({
          path: pi.binDirectory,
          installationRoot: join(directory, "inspire"),
        });

        expect(installation.commandPath).toBe(pi.commandPath);
        expect(installation.packageRoot).toBe(pi.packageRoot);
      } finally {
        if (configuredCommand === undefined)
          delete process.env.INSPIRE_PI_COMMAND;
        else process.env.INSPIRE_PI_COMMAND = configuredCommand;
      }
    },
  );
});
