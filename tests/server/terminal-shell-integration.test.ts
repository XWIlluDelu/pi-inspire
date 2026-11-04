import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedTerminalProfile } from "../../server/terminal-profiles.js";
import { integratedTerminalLaunch } from "../../server/terminal-shell-integration.js";

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
    expect(bash.args).toEqual(["-l", "-i"]);
    expect(bash.env.PROMPT_COMMAND).toContain("bash-login-init.sh");
    const nonlogin = integratedTerminalLaunch(
      profile("/bin/bash", []),
      "/private/integration",
      {},
    );
    expect(nonlogin.args).toEqual([
      "--init-file",
      join("/private/integration", "bash-init.sh"),
      "-i",
    ]);
    expect(nonlogin.env.PROMPT_COMMAND).toBeUndefined();
    const zsh = integratedTerminalLaunch(
      profile("/bin/zsh"),
      "/private/integration",
      { ZDOTDIR: "/original" },
    );
    expect(zsh.env.ZDOTDIR).toBe(join("/private/integration", "zsh"));
    expect(zsh.enabled).toBe(true);
    const powershell = integratedTerminalLaunch(
      profile("powershell.exe"),
      "/private/integration",
      {},
    );
    expect(powershell.args).toEqual([
      "-NoLogo",
      "-NoExit",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join("/private/integration", "powershell-integration.ps1"),
    ]);
    expect(powershell.env.PSExecutionPolicyPreference).toBeUndefined();
    const fish = integratedTerminalLaunch(
      profile("/usr/bin/fish"),
      "/private/it's",
      {},
    );
    const fishScript = join("/private/it's", "fish-integration.fish");
    expect(fish.args.join(" ")).toContain(
      `'${fishScript.replaceAll("'", "'\\''")}'`,
    );
  });
});
