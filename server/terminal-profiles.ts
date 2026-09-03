import { accessSync, constants, realpathSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import type { TerminalProfile } from "../shared/terminal-contracts.js";

export interface ResolvedTerminalProfile extends TerminalProfile {
  shell: string;
  args: string[];
}

const POSIX_SHELLS = ["zsh", "bash", "fish", "nu", "sh"];
const WINDOWS_SHELLS = ["pwsh.exe", "powershell.exe", "cmd.exe", "wsl.exe"];

function canExecute(path: string): boolean {
  try {
    accessSync(
      path,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function pathIdentity(path: string): string {
  try {
    const canonical = realpathSync.native(path);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch {
    return process.platform === "win32" ? path.toLowerCase() : path;
  }
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(command)) return canExecute(command) ? command : null;
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  const commandHasExtension = extensions.some((extension) =>
    command.toLowerCase().endsWith(extension.toLowerCase()),
  );
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(
        directory,
        commandHasExtension ? command : `${command}${extension}`,
      );
      if (canExecute(candidate)) return candidate;
    }
  }
  return null;
}

function profileId(shell: string): string {
  return basename(shell)
    .toLowerCase()
    .replace(/\.exe$/u, "");
}

function labelForShell(shell: string): string {
  const id = profileId(shell);
  if (id === "pwsh") return "PowerShell";
  if (id === "powershell") return "Windows PowerShell";
  if (id === "cmd") return "Command Prompt";
  if (id === "nu") return "Nushell";
  if (id === "wsl") return "WSL";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function loginArgs(shell: string): string[] {
  if (process.platform === "win32") return [];
  return ["sh", "bash", "zsh", "fish"].includes(profileId(shell)) ? ["-l"] : [];
}

export function discoverTerminalProfiles(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTerminalProfile[] {
  const preferred =
    process.platform === "win32"
      ? (env.COMSPEC ?? "cmd.exe")
      : (env.SHELL ?? "/bin/sh");
  const candidates = [
    preferred,
    ...(process.platform === "win32" ? WINDOWS_SHELLS : POSIX_SHELLS),
  ];
  const profiles: ResolvedTerminalProfile[] = [];
  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();

  for (const command of candidates) {
    const shell = findOnPath(command, env);
    if (!shell) continue;
    const identity = pathIdentity(shell);
    if (seenPaths.has(identity)) continue;
    seenPaths.add(identity);
    let id = profileId(shell);
    if (seenIds.has(id)) id = `${id}-${profiles.length + 1}`;
    seenIds.add(id);
    profiles.push({
      id,
      label: labelForShell(shell),
      shell,
      args: loginArgs(shell),
      available: true,
      isDefault: profiles.length === 0,
    });
  }

  if (profiles.length === 0) {
    const fallback = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    profiles.push({
      id: profileId(fallback),
      label: labelForShell(fallback),
      shell: fallback,
      args: loginArgs(fallback),
      available: false,
      isDefault: true,
    });
  }
  return profiles;
}

export function publicTerminalProfiles(
  profiles: ResolvedTerminalProfile[],
): TerminalProfile[] {
  return profiles.map((profile) => ({
    id: profile.id,
    label: profile.label,
    available: profile.available,
    isDefault: profile.isDefault,
  }));
}
