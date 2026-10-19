import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ResolvedTerminalProfile } from "./terminal-profiles.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
interface IntegratedTerminalLaunch {
  args: string[];
  env: NodeJS.ProcessEnv;
  enabled: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`The terminal integration directory is invalid: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error(
      `The terminal integration directory is owned by another user: ${path}`,
    );
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function replacePrivateFile(
  path: string,
  content: string,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, PRIVATE_FILE_MODE);
}

function shellLiteral(value: string): string {
  return value.replaceAll("__INSPIRE_OPEN__", "${");
}

const bashIntegration =
  shellLiteral(String.raw`__inspire_encode_terminal_value() {
  local value="$1"
  value="__INSPIRE_OPEN__value//%/%25}"
  value="__INSPIRE_OPEN__value//$'\033'/%1B}"
  value="__INSPIRE_OPEN__value//$'\007'/%07}"
  value="__INSPIRE_OPEN__value//$'\r'/%0D}"
  value="__INSPIRE_OPEN__value//$'\n'/%0A}"
  printf '%s' "$value"
}
__inspire_terminal_preexec() {
  local command
  # fc -1 can select the previous entry while expanding a PS0 containing
  # command substitution. history reports the accepted line on both PS0 and
  # the older DEBUG path, without evaluating any part of the user's input.
  command="$(HISTTIMEFORMAT= builtin history 1)"
  command="__INSPIRE_OPEN__command#*[0-9]  }"
  command="__INSPIRE_OPEN__command#"__INSPIRE_OPEN__command%%[![:space:]]*}"}"
  command="$(__inspire_encode_terminal_value "$command")"
  printf '\033]6973;C1;%s\007' "$command"
}
__inspire_terminal_prompt() {
  local command_status=$?
  local cwd
  cwd="$(__inspire_encode_terminal_value "$PWD")"
  __inspire_terminal_ready=
  printf '\033]6973;P1;%s\007\033]6973;D;%d\007\033]6973;A\007' "$cwd" "$command_status"
  return "$command_status"
}
if [[ -n __INSPIRE_OPEN__PROMPT_COMMAND+x} ]]; then
  __inspire_original_prompt_command=("__INSPIRE_OPEN__PROMPT_COMMAND[@]}")
else
  __inspire_original_prompt_command=()
fi
if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
  PROMPT_COMMAND=(__inspire_terminal_prompt "__INSPIRE_OPEN____inspire_original_prompt_command[@]}")
else
  # Array-valued PROMPT_COMMAND is only executed as an array since Bash 5.1.
  unset PROMPT_COMMAND
  printf -v PROMPT_COMMAND '%s\n' __inspire_terminal_prompt "__INSPIRE_OPEN____inspire_original_prompt_command[@]}"
fi
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  __inspire_original_ps0="__INSPIRE_OPEN__PS0-}"
  PS0='$(__inspire_terminal_preexec)'"$__inspire_original_ps0"
else
  # System Bash on macOS predates PS0. Observe one top-level DEBUG event per
  # accepted command, not each simple command or the prompt itself.
  __inspire_terminal_uses_debug=1
  __inspire_terminal_debug() {
    local command_status=$?
    # The login bootstrap can precede the rest of the first PROMPT_COMMAND.
    # Do not mistake those startup callbacks for an accepted history entry.
    if [[ -n __INSPIRE_OPEN____inspire_bootstrap_history+x} ]]; then
      if [[ "$(HISTTIMEFORMAT= builtin history 1)" == "$__inspire_bootstrap_history" ]]; then
        return "$command_status"
      fi
      unset __inspire_bootstrap_history
    fi
    if [[ "$__inspire_terminal_ready" == 1 && "$BASH_COMMAND" != __inspire_terminal_prompt && "$BASH_SUBSHELL" == 0 ]]; then
      __inspire_terminal_ready=
      __inspire_terminal_preexec
    fi
    return "$command_status"
  }
  if [[ -n "$__inspire_original_debug_trap" ]]; then
    __inspire_original_debug_trap="__INSPIRE_OPEN____inspire_original_debug_trap#trap -- }"
    __inspire_original_debug_trap="__INSPIRE_OPEN____inspire_original_debug_trap% DEBUG}"
    eval "__inspire_original_debug_trap=$__inspire_original_debug_trap"
  fi
  PROMPT_COMMAND+=$'\n__inspire_terminal_ready=1'
fi
`);

// eval, unlike sourcing another file/function, does not restore Bash 3's old
// DEBUG trap on return. The script is app-owned, never user-provided argv text.
const bashLoginBootstrap =
  '__inspire_bash_initial_status=$?; eval -- "$(<"$INSPIRE_SHELL_INTEGRATION_DIR/bash-login-init.sh")"';

const bashWritablePrompt = String.raw`__inspire_bash_writable_prompt() {
  local declaration flags
  for declaration in "$(declare -p PROMPT_COMMAND 2>/dev/null)" "$(declare -p PS0 2>/dev/null)"; do
    flags="__INSPIRE_OPEN__declaration#declare -}"
    flags="__INSPIRE_OPEN__flags%% *}"
    if [[ "$flags" == *r* ]]; then return 1; fi
  done
}
`;
const bashInstall = String.raw`__inspire_original_debug_trap="$(trap -p DEBUG)"
. "__INSPIRE_OPEN__INSPIRE_SHELL_INTEGRATION_DIR}/bash-integration.sh"
if [[ "__INSPIRE_OPEN____inspire_terminal_uses_debug-}" == 1 ]]; then
  trap '__inspire_terminal_debug; eval "$__inspire_original_debug_trap"' DEBUG
fi
`;

const bashWrapper = shellLiteral(
  // Bash itself runs its compiled system bashrc before --init-file. Nonlogin
  // user startup reads only .bashrc, never a login profile or /etc/profile.
  String.raw`if [[ -r "$HOME/.bashrc" ]]; then . "$HOME/.bashrc"; fi
` +
    bashWritablePrompt +
    String.raw`if __inspire_bash_writable_prompt; then
` +
    bashInstall +
    String.raw`fi
unset -f __inspire_bash_writable_prompt
`,
);

const bashLoginInit = shellLiteral(
  String.raw`__inspire_bash_bootstrap_active=
` +
    bashWritablePrompt +
    String.raw`if __inspire_bash_writable_prompt; then
  __inspire_bash_bootstrap=__INSPIRE_BASH_BOOTSTRAP__
  __inspire_bash_bootstrap_found=
  for __inspire_bash_index in "__INSPIRE_OPEN__!PROMPT_COMMAND[@]}"; do
    __inspire_bash_value="__INSPIRE_OPEN__PROMPT_COMMAND[$__inspire_bash_index]}"
    if [[ "$__inspire_bash_value" == "$__inspire_bash_bootstrap"* ]]; then
      __inspire_bash_bootstrap_found=1
      __inspire_bash_value="__INSPIRE_OPEN____inspire_bash_value#"$__inspire_bash_bootstrap"}"
      __inspire_bash_value="__INSPIRE_OPEN____inspire_bash_value#"__INSPIRE_OPEN____inspire_bash_value%%[![:space:]]*}"}"
      __inspire_bash_value="__INSPIRE_OPEN____inspire_bash_value#;}"
      if [[ -z "$__inspire_bash_value" ]]; then
        unset "PROMPT_COMMAND[$__inspire_bash_index]"
      else
        PROMPT_COMMAND[$__inspire_bash_index]="$__inspire_bash_value"
      fi
    fi
  done
  # A profile may move the bootstrap inside arbitrary shell syntax. Do not
  # rewrite that syntax or recursively install callbacks on every prompt.
  if [[ "$__inspire_bash_bootstrap_found" == 1 ]]; then
    # Do not export app-private prompt functions into nested, ordinary shells.
    if [[ "$INSPIRE_BASH_PROMPT_COMMAND_EXPORTED" != 1 ]]; then export -n PROMPT_COMMAND; fi
    unset INSPIRE_BASH_PROMPT_COMMAND_EXPORTED
` +
    bashInstall +
    String.raw`  __inspire_bash_bootstrap_active=1
  fi
  unset __inspire_bash_bootstrap_found __inspire_bash_bootstrap __inspire_bash_index __inspire_bash_value
fi
unset -f __inspire_bash_writable_prompt
__inspire_bash_restore_status() {
  local command_status="$1"
  unset -f __inspire_bash_restore_status
  return "$command_status"
}
__inspire_bash_finish_bootstrap() {
  local command_status="$__inspire_bash_initial_status"
  unset __inspire_bash_initial_status
  unset -f __inspire_bash_finish_bootstrap
  if [[ "$__inspire_bash_bootstrap_active" == 1 ]]; then
    unset __inspire_bash_bootstrap_active
    __inspire_bash_restore_status "$command_status"
    __inspire_terminal_prompt
    if [[ "__INSPIRE_OPEN____inspire_terminal_uses_debug-}" == 1 ]]; then
      __inspire_bootstrap_history="$(HISTTIMEFORMAT= builtin history 1)"
      __inspire_terminal_ready=1
    fi
  else
    unset __inspire_bash_bootstrap_active
    unset -f __inspire_bash_restore_status
  fi
  return "$command_status"
}
__inspire_bash_finish_bootstrap
`,
).replace("__INSPIRE_BASH_BOOTSTRAP__", shellQuote(bashLoginBootstrap));

const zshIntegration =
  shellLiteral(String.raw`__inspire_encode_terminal_value() {
  local value="$1"
  value="__INSPIRE_OPEN__value//%/%25}"
  value="__INSPIRE_OPEN__value//$'\033'/%1B}"
  value="__INSPIRE_OPEN__value//$'\007'/%07}"
  value="__INSPIRE_OPEN__value//$'\r'/%0D}"
  value="__INSPIRE_OPEN__value//$'\n'/%0A}"
  print -rn -- "$value"
}
__inspire_terminal_preexec() {
  printf '\033]6973;C1;%s\007' "$(__inspire_encode_terminal_value "$1")"
}
__inspire_terminal_precmd() {
  local command_status=$?
  printf '\033]6973;P1;%s\007\033]6973;D;%d\007\033]6973;A\007' "$(__inspire_encode_terminal_value "$PWD")" "$command_status"
}
typeset -ga preexec_functions precmd_functions
preexec_functions=(__inspire_terminal_preexec __INSPIRE_OPEN__preexec_functions:#__inspire_terminal_preexec})
precmd_functions=(__inspire_terminal_precmd __INSPIRE_OPEN__precmd_functions:#__inspire_terminal_precmd})
`);

const fishIntegration = String.raw`function __inspire_encode_terminal_value
  string escape --style=url -- "$argv"
end
function __inspire_terminal_preexec --on-event fish_preexec
  printf '\e]6973;C1;%s\a' (__inspire_encode_terminal_value "$argv")
end
function __inspire_terminal_postexec --on-event fish_postexec
  set -l command_status $status
  printf '\e]6973;P1;%s\a\e]6973;D;%d\a\e]6973;A\a' (__inspire_encode_terminal_value "$PWD") $command_status
end
printf '\e]6973;P1;%s\a\e]6973;A\a' (__inspire_encode_terminal_value "$PWD")
`;

const powerShellWrapper = [
  "$script:InspireOriginalPrompt = $function:prompt",
  "$script:InspireOriginalReadLine = $function:PSConsoleHostReadLine",
  "if ($script:InspireOriginalReadLine) {",
  "  function global:PSConsoleHostReadLine {",
  "    $line = & $script:InspireOriginalReadLine",
  "    try {",
  "      $command = [Uri]::EscapeDataString($line)",
  '      [Console]::Write("{0}]6973;C1;{1}`a", [char]27, $command)',
  "    } catch {}",
  "    return $line",
  "  }",
  "}",
  "function global:prompt {",
  "  $commandStatus = if ($?) { 0 } elseif (($global:LASTEXITCODE -is [int]) -and ($global:LASTEXITCODE -ne 0)) { $global:LASTEXITCODE } else { 1 }",
  "  $cwd = [Uri]::EscapeDataString($executionContext.SessionState.Path.CurrentLocation.Path)",
  '  [Console]::Write("{0}]6973;P1;{1}`a{0}]6973;D;{2}`a{0}]6973;A`a", [char]27, $cwd, $commandStatus)',
  '  if ($script:InspireOriginalPrompt) { & $script:InspireOriginalPrompt } else { "PS $cwd> " }',
  "}",
  "",
].join("\n");

/** Materialize immutable, user-private wrappers before any PTY is spawned. */
export async function ensureTerminalShellIntegration(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await ensurePrivateDirectory(directory);
  await replacePrivateFile(
    join(directory, "bash-integration.sh"),
    bashIntegration,
  );
  await replacePrivateFile(join(directory, "bash-init.sh"), bashWrapper);
  await replacePrivateFile(
    join(directory, "bash-login-init.sh"),
    bashLoginInit,
  );
  await replacePrivateFile(
    join(directory, "zsh-integration.zsh"),
    zshIntegration,
  );
  await replacePrivateFile(
    join(directory, "fish-integration.fish"),
    fishIntegration,
  );
  await replacePrivateFile(
    join(directory, "powershell-integration.ps1"),
    powerShellWrapper,
  );

  const zshDirectory = join(directory, "zsh");
  await ensurePrivateDirectory(zshDirectory);
  // User startup files can move ZDOTDIR at every stage. Restore its exact
  // declaration (including unset/exported state) before sourcing the next file,
  // then temporarily route only the remaining startup stages through us.
  const source = (name: string): string =>
    `if [[ -r "\${ZDOTDIR-$HOME}/${name}" ]]; then source "\${ZDOTDIR-$HOME}/${name}"; fi\n`;
  const remember =
    '__inspire_user_zdotdir="$(typeset -p ZDOTDIR 2>/dev/null || :)"\n';
  const restore =
    'unset ZDOTDIR\nif [[ -n $__inspire_user_zdotdir ]]; then eval "$__inspire_user_zdotdir"; fi\n';
  const route = `if [[ -o rcs && \${(t)ZDOTDIR} != *readonly* ]]; then export ZDOTDIR=${shellQuote(zshDirectory)}; else unset __inspire_user_zdotdir; fi\n`;
  const finish = "unset __inspire_user_zdotdir\n";
  const original =
    env.ZDOTDIR === undefined
      ? "unset ZDOTDIR\n"
      : `export ZDOTDIR=${shellQuote(env.ZDOTDIR)}\n`;
  await replacePrivateFile(
    join(zshDirectory, ".zshenv"),
    `${original}${source(".zshenv")}${remember}if [[ -o login || -o interactive ]]; then\n${route}else\n${finish}fi\n`,
  );
  await replacePrivateFile(
    join(zshDirectory, ".zprofile"),
    `${restore}${source(".zprofile")}${remember}${route}`,
  );
  await replacePrivateFile(
    join(zshDirectory, ".zshrc"),
    `${restore}${source(".zshrc")}source ${shellQuote(join(directory, "zsh-integration.zsh"))}\nif [[ -o login ]]; then\n${remember}${route}else\n${finish}fi\n`,
  );
  await replacePrivateFile(
    join(zshDirectory, ".zlogin"),
    `${restore}${source(".zlogin")}${finish}`,
  );
  await replacePrivateFile(
    join(zshDirectory, ".zlogout"),
    "# User ZDOTDIR is restored during startup; zsh owns the normal logout files.\n",
  );
}

export function integratedTerminalLaunch(
  profile: ResolvedTerminalProfile,
  directory: string | null,
  baseEnv: NodeJS.ProcessEnv,
): IntegratedTerminalLaunch {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    TERM_PROGRAM: "Inspire",
    TERM_PROGRAM_VERSION: "1",
  };
  if (!directory) return { args: [...profile.args], env, enabled: false };
  const shell = basename(profile.shell)
    .toLowerCase()
    .replace(/\.exe$/u, "");
  env.INSPIRE_SHELL_INTEGRATION_DIR = directory;
  if (shell === "bash") {
    const login = profile.args.some(
      (argument) => argument === "--login" || /^-[^-]*l/u.test(argument),
    );
    if (login) {
      return {
        args: [...profile.args, "-i"],
        env: {
          ...env,
          PROMPT_COMMAND:
            bashLoginBootstrap +
            (baseEnv.PROMPT_COMMAND ? "\n" + baseEnv.PROMPT_COMMAND : ""),
          INSPIRE_BASH_PROMPT_COMMAND_EXPORTED:
            baseEnv.PROMPT_COMMAND === undefined ? "0" : "1",
        },
        enabled: true,
      };
    }
    return {
      args: [
        "--init-file",
        join(directory, "bash-init.sh"),
        ...profile.args,
        "-i",
      ],
      env,
      enabled: true,
    };
  }
  if (shell === "zsh")
    return {
      args: [...profile.args],
      env: { ...env, ZDOTDIR: join(directory, "zsh") },
      enabled: true,
    };
  if (shell === "fish")
    return {
      args: [
        ...profile.args,
        "--init-command",
        `source ${shellQuote(join(directory, "fish-integration.fish"))}`,
      ],
      env,
      enabled: true,
    };
  if (shell === "pwsh" || shell === "powershell")
    return {
      args: [
        "-NoLogo",
        "-NoExit",
        // Only this shell process: never change CurrentUser/LocalMachine
        // policy, and let enforced Group Policy retain precedence.
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(directory, "powershell-integration.ps1"),
      ],
      env,
      enabled: true,
    };
  return { args: [...profile.args], env, enabled: false };
}
