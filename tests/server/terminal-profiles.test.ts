import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverTerminalProfiles,
  type ResolvedTerminalProfile,
} from "../../server/terminal-profiles.js";
import { integratedTerminalLaunch } from "../../server/terminal-shell-integration.js";

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
    "keeps the preferred executable path while ignoring aliases and directories",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inspire-shells-"));
      const preferred = join(directory, "preferred-shell");
      try {
        await mkdir(join(directory, "zsh"));
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

describe("launching terminal profiles", () => {
  const profile = (
    shell: string,
    args: string[] = [],
  ): ResolvedTerminalProfile => ({
    id: "fixture",
    label: "Fixture shell",
    shell,
    args,
    available: true,
    isDefault: true,
  });

  it("leaves arguments intact for a shell without integration", () => {
    expect(
      integratedTerminalLaunch(profile("nu", ["--login"]), "hooks", {}),
    ).toMatchObject({
      args: ["--login"],
      enabled: false,
    });
  });

  it("applies the PowerShell policy only through the launched process arguments", () => {
    const { args, env } = integratedTerminalLaunch(
      profile("powershell.exe"),
      "hooks",
      {},
    );
    const policy = args.indexOf("-ExecutionPolicy");
    expect(args.slice(policy, policy + 2)).toEqual([
      "-ExecutionPolicy",
      "Bypass",
    ]);
    expect(args.slice(-2)).toEqual([
      "-File",
      join("hooks", "powershell-integration.ps1"),
    ]);
    expect(env).not.toHaveProperty("PSExecutionPolicyPreference");
  });

  it("quotes fish's startup path containing an apostrophe", () => {
    const { args } = integratedTerminalLaunch(
      profile("fish", ["-l"]),
      "it's",
      {},
    );
    expect(args).toEqual([
      "-l",
      "--init-command",
      `source 'it'\\''s${sep}fish-integration.fish'`,
    ]);
  });
});
