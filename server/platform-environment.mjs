import { statSync } from "node:fs";
import { win32 } from "node:path";

/** Windows variable names remain case-insensitive in plain copied environments.
 * Follow Node's lexicographic duplicate-key choice when conflicting spellings
 * exist; POSIX names and empty values keep their ordinary meaning. */
export function environmentValue(
  environment,
  name,
  platform = process.platform,
) {
  if (platform !== "win32") return environment[name];
  const wanted = name.toLowerCase();
  const key = Object.keys(environment)
    .filter((key) => key.toLowerCase() === wanted)
    .sort()[0];
  return key === undefined ? undefined : environment[key];
}

/** Windows operations use current PowerShell, not the legacy inbox engine.
 * Honor named PATH locations, then the normal PowerShell 7 installation.
 * Missing dependencies fail normally; do not search the working directory or
 * silently switch versions. */
export function windowsPowerShellCommand(environment = process.env) {
  for (const directory of executablePathDirectories(
    environmentValue(environment, "PATH", "win32") ?? "",
    "win32",
  )) {
    const candidate = win32.join(directory, "pwsh.exe");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // This named PATH location does not provide PowerShell.
    }
  }
  const programFiles =
    environmentValue(environment, "ProgramFiles", "win32") ?? "C:\\Program Files";
  return win32.join(programFiles, "PowerShell", "7", "pwsh.exe");
}

/** Named PATH directories only, preserving the existing refusal to introduce
 * implicit cwd search. Windows permits quoted entries containing semicolons;
 * quote characters are literal parts of a POSIX directory name. */
export function executablePathDirectories(
  value,
  platform = process.platform,
) {
  if (platform !== "win32") return value.split(":").filter(Boolean);
  const entries = [];
  let entry = "";
  let quoted = false;
  const append = () => {
    const directory =
      entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    if (directory) entries.push(directory);
    entry = "";
  };
  for (const character of value) {
    if (character === ";" && !quoted) append();
    else {
      if (character === '"') quoted = !quoted;
      entry += character;
    }
  }
  append();
  return entries;
}
