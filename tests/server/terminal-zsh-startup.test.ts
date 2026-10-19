import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { discoverTerminalProfiles } from "../../server/terminal-profiles.js";
import {
  ensureTerminalShellIntegration,
  integratedTerminalLaunch,
} from "../../server/terminal-shell-integration.js";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";

const execFile = promisify(execFileCallback);
const zsh = discoverTerminalProfiles().find((profile) => profile.id === "zsh");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inspire-zsh-'startup-"));
  roots.push(root);
  const env = isolatedTestEnvironment(root);
  delete env.ZDOTDIR;
  return { root, env, integration: join(root, "integration") };
}

describe.runIf(zsh)("native zsh startup continuity", () => {
  it.each([false, true])(
    "follows ZDOTDIR changes at each login stage (exported initially: %s)",
    async (initiallySet) => {
      const f = await fixture();
      const initial = initiallySet ? join(f.root, "original") : f.root;
      const first = join(f.root, "config one");
      const second = join(f.root, "config two");
      await Promise.all(
        [initial, first, second].map((path) =>
          mkdir(path, { recursive: true }),
        ),
      );
      if (initiallySet) f.env.ZDOTDIR = initial;
      await writeFile(
        join(initial, ".zshenv"),
        'export USER_ENV_SEEN=yes\nexport ZDOTDIR="$HOME/config one"\n',
      );
      await writeFile(
        join(first, ".zprofile"),
        'export USER_PROFILE_SEEN=yes\nexport ZDOTDIR="$HOME/config two"\n',
      );
      await writeFile(
        join(second, ".zshrc"),
        'user_startup_function() { print -r -- "USER_FUNCTION"; }\nexport USER_RC_SEEN=yes\n',
      );
      await writeFile(join(second, ".zlogin"), "export USER_LOGIN_SEEN=yes\n");
      await writeFile(join(second, ".zlogout"), 'print -r -- "USER_LOGOUT"\n');
      await ensureTerminalShellIntegration(f.integration, f.env);
      const launch = integratedTerminalLaunch(
        { ...zsh!, args: ["-l"] },
        f.integration,
        f.env,
      );
      const { stdout } = await execFile(
        zsh!.shell,
        [
          ...launch.args,
          "-i",
          "-c",
          [
            'print -r -- "STAGES:$USER_ENV_SEEN:$USER_PROFILE_SEEN:$USER_RC_SEEN:$USER_LOGIN_SEEN"',
            'print -r -- "DIRECTORY:$ZDOTDIR"',
            'print -r -- "HOOK:${precmd_functions[(Ie)__inspire_terminal_precmd]}"',
            "user_startup_function",
          ].join("\n"),
        ],
        { env: launch.env, timeout: 10_000 },
      );
      expect(stdout).toContain("STAGES:yes:yes:yes:yes");
      expect(stdout).toContain("DIRECTORY:" + second);
      expect(stdout).toContain("HOOK:1");
      expect(stdout).toContain("USER_FUNCTION");
      expect(stdout.match(/USER_LOGOUT/gu)).toHaveLength(1);
    },
  );

  it.each([true, false])(
    "preserves an unset ZDOTDIR for user rc files and the final shell (login: %s)",
    async (login) => {
      const f = await fixture();
      await writeFile(
        join(f.root, ".zshrc"),
        "if (( ${+ZDOTDIR} )); then export USER_CONFIG_STATE=set; else export USER_CONFIG_STATE=unset; fi\n",
      );
      await ensureTerminalShellIntegration(f.integration, f.env);
      const launch = integratedTerminalLaunch(
        { ...zsh!, args: login ? ["-l"] : [] },
        f.integration,
        f.env,
      );
      const { stdout } = await execFile(
        zsh!.shell,
        [
          ...launch.args,
          "-i",
          "-c",
          [
            'print -r -- "STATE:$USER_CONFIG_STATE:${+ZDOTDIR}"',
            'print -r -- "HOOK:${precmd_functions[(Ie)__inspire_terminal_precmd]}"',
          ].join("\n"),
        ],
        { env: launch.env, timeout: 10_000 },
      );
      expect(stdout).toContain("STATE:unset:0");
      expect(stdout).toContain("HOOK:1");
    },
  );
  it.each(["env", "profile"])(
    "respects a user disabling further startup files from %s",
    async (stage) => {
      const f = await fixture();
      const config = join(f.root, "config");
      await mkdir(config);
      await writeFile(
        join(f.root, ".zshenv"),
        'ZDOTDIR="$HOME/config"\n' + (stage === "env" ? "unsetopt rcs\n" : ""),
      );
      await writeFile(
        join(config, ".zprofile"),
        "unset ZDOTDIR\nunsetopt rcs\n",
      );
      await writeFile(
        join(config, ".zshrc"),
        'print -r -- "SHOULD_NOT_LOAD"\n',
      );
      await ensureTerminalShellIntegration(f.integration, f.env);
      const launch = integratedTerminalLaunch(
        { ...zsh!, args: ["-l"] },
        f.integration,
        f.env,
      );
      const { stdout } = await execFile(
        zsh!.shell,
        [...launch.args, "-i", "-c", 'print -r -- "FINAL:${ZDOTDIR-unset}"'],
        { env: launch.env, timeout: 10_000 },
      );
      expect(stdout).toContain("FINAL:" + (stage === "env" ? config : "unset"));
      expect(stdout).not.toContain("SHOULD_NOT_LOAD");
    },
  );
});
