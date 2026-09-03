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
  command="$(builtin fc -ln -1 2>/dev/null)"
  command="__INSPIRE_OPEN__command#"__INSPIRE_OPEN__command%%[![:space:]]*}"}"
  command="$(__inspire_encode_terminal_value "$command")"
  printf '\033]6973;C1;%s\007' "$command"
}
__inspire_terminal_prompt() {
  local command_status=$?
  local cwd
  cwd="$(__inspire_encode_terminal_value "$PWD")"
  printf '\033]6973;P1;%s\007\033]6973;D;%d\007\033]6973;A\007' "$cwd" "$command_status"
}
if [[ -n __INSPIRE_OPEN__PROMPT_COMMAND+x} ]]; then
  __inspire_original_prompt_command=("__INSPIRE_OPEN__PROMPT_COMMAND[@]}")
  PROMPT_COMMAND=(__inspire_terminal_prompt "__INSPIRE_OPEN____inspire_original_prompt_command[@]}")
else
  PROMPT_COMMAND=(__inspire_terminal_prompt)
fi
__inspire_original_ps0="__INSPIRE_OPEN__PS0-}"
PS0='$(__inspire_terminal_preexec)'"$__inspire_original_ps0"
`);

const bashWrapper =
  shellLiteral(String.raw`# Preserve login initialization, then install INSΠRE's non-printing shell markers.
if [ -r /etc/profile ]; then . /etc/profile; fi
if [ -r "$HOME/.bash_profile" ]; then
  . "$HOME/.bash_profile"
elif [ -r "$HOME/.bash_login" ]; then
  . "$HOME/.bash_login"
elif [ -r "$HOME/.profile" ]; then
  . "$HOME/.profile"
elif [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
. "__INSPIRE_OPEN__INSPIRE_SHELL_INTEGRATION_DIR}/bash-integration.sh"
`);

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
  "try {",
  "  $enterHandler = Get-PSReadLineKeyHandler -Chord Enter -ErrorAction Stop",
  '  if ($enterHandler.Function -eq "AcceptLine") {',
  "    Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {",
  "      try {",
  "        $line = ''",
  "        $cursor = 0",
  "        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)",
  "        $command = [Uri]::EscapeDataString($line)",
  '        [Console]::Write("{0}]6973;C1;{1}`a", [char]27, $command)',
  "      } catch {}",
  "      [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()",
  "    }",
  "  }",
  "} catch {}",
  "function global:prompt {",
  "  $commandStatus = if ($?) { 0 } elseif ($global:LASTEXITCODE -is [int]) { $global:LASTEXITCODE } else { 1 }",
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
  const original = env.ZDOTDIR || env.HOME || "";
  const source = (name: string): string =>
    original
      ? `if [[ -r ${shellQuote(join(original, name))} ]]; then source ${shellQuote(join(original, name))}; fi\n`
      : "";
  await replacePrivateFile(
    join(zshDirectory, ".zshenv"),
    `${source(".zshenv")}export ZDOTDIR=${shellQuote(zshDirectory)}\n`,
  );
  await replacePrivateFile(
    join(zshDirectory, ".zprofile"),
    source(".zprofile"),
  );
  await replacePrivateFile(
    join(zshDirectory, ".zshrc"),
    `${source(".zshrc")}source ${shellQuote(join(directory, "zsh-integration.zsh"))}\n`,
  );
  await replacePrivateFile(join(zshDirectory, ".zlogin"), source(".zlogin"));
  await replacePrivateFile(join(zshDirectory, ".zlogout"), source(".zlogout"));
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
  if (shell === "bash")
    return {
      args: ["--init-file", join(directory, "bash-init.sh"), "-i"],
      env,
      enabled: true,
    };
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
        "-File",
        join(directory, "powershell-integration.ps1"),
      ],
      env,
      enabled: true,
    };
  return { args: [...profile.args], env, enabled: false };
}
