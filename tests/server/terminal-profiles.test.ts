import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverTerminalProfiles } from "../../server/terminal-profiles.js";

describe("terminal profiles", () => {
  it.runIf(process.platform === "win32")(
    "discovers copied mixed-case Windows environments and quoted semicolon PATH entries",
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "inspire-windows-shells-"),
      );
      try {
        const bin = join(directory, "Program Files;Tools");
        await mkdir(bin);
        const cmd = join(bin, "cmd.exe");
        const pwsh = join(bin, "pwsh.exe");
        await writeFile(cmd, "discovery fixture");
        await writeFile(pwsh, "discovery fixture");
        const profiles = discoverTerminalProfiles({
          ComSpec: cmd,
          Path: '"' + bin + '"',
          pathext: ".EXE;.CMD",
        });
        expect(profiles[0]).toMatchObject({
          id: "pwsh",
          shell: pwsh,
          available: true,
          isDefault: true,
        });
        expect(profiles).toContainEqual(
          expect.objectContaining({ id: "cmd", shell: cmd, available: true }),
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not advertise an executable directory as a shell",
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "inspire-shell-directory-"),
      );
      try {
        await mkdir(join(directory, "bash"));
        const profiles = discoverTerminalProfiles({
          SHELL: directory,
          PATH: directory,
        });
        expect(profiles.every((profile) => !profile.available)).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "deduplicates executable aliases without changing the preferred shell path",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inspire-shells-"));
      const preferred = join(directory, "preferred-shell");
      try {
        await symlink(process.execPath, preferred);
        await symlink(process.execPath, join(directory, "bash"));

        const profiles = discoverTerminalProfiles({
          SHELL: preferred,
          PATH: directory,
        });

        expect(profiles).toHaveLength(1);
        expect(profiles[0]).toMatchObject({
          id: "preferred-shell",
          shell: preferred,
          isDefault: true,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
