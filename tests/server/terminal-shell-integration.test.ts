import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedTerminalProfile } from "../../server/terminal-profiles.js";
import {
  ensureTerminalShellIntegration,
  integratedTerminalLaunch,
} from "../../server/terminal-shell-integration.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inspire-shell-integration-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function profile(shell: string, args = ["-l"]): ResolvedTerminalProfile {
  return {
    id: shell.split("/").at(-1) ?? shell,
    label: "Shell",
    shell,
    args,
    available: true,
    isDefault: true,
  };
}

describe("terminal shell integration", () => {
  it("writes private wrappers without unresolved placeholders", async () => {
    const directory = join(await temporaryRoot(), "shell");
    await ensureTerminalShellIntegration(directory, {
      HOME: "/home/example",
    });
    const bash = await readFile(join(directory, "bash-integration.sh"), "utf8");
    const wrapper = await readFile(join(directory, "bash-init.sh"), "utf8");
    const powershell = await readFile(
      join(directory, "powershell-integration.ps1"),
      "utf8",
    );
    expect(bash).toContain("6973;C1;");
    expect(powershell).toContain("PSConsoleReadLine]::GetBufferState");
    expect(powershell).toContain("6973;C1;");
    expect(powershell).toContain("[char]27");
    expect(powershell).not.toContain('"`e]6973');
    expect(bash).toContain("${value//$'\\033'/%1B}");
    expect(wrapper).toContain("${INSPIRE_SHELL_INTEGRATION_DIR}");
    expect(`${bash}${wrapper}`).not.toContain("__INSPIRE_OPEN__");
  });

  it("preserves unsupported profiles and adds terminal identity", () => {
    const launch = integratedTerminalLaunch(
      profile("/bin/nu", []),
      "/private/integration",
      { PATH: "/bin" },
    );
    expect(launch).toMatchObject({ args: [], enabled: false });
    expect(launch.env).toMatchObject({
      PATH: "/bin",
      TERM_PROGRAM: "Inspire",
      TERM_PROGRAM_VERSION: "1",
    });
  });

  it("selects shell-specific non-printing startup hooks", () => {
    const bash = integratedTerminalLaunch(
      profile("/bin/bash"),
      "/private/integration",
      {},
    );
    expect(bash.args).toEqual([
      "--init-file",
      "/private/integration/bash-init.sh",
      "-i",
    ]);
    const zsh = integratedTerminalLaunch(
      profile("/bin/zsh"),
      "/private/integration",
      { ZDOTDIR: "/original" },
    );
    expect(zsh.env.ZDOTDIR).toBe("/private/integration/zsh");
    expect(zsh.enabled).toBe(true);
    const fish = integratedTerminalLaunch(
      profile("/usr/bin/fish"),
      "/private/it's",
      {},
    );
    expect(fish.args.join(" ")).toContain(
      "'/private/it'\\''s/fish-integration.fish'",
    );
  });
});
