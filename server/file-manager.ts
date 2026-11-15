import {
  type ExecFileOptions,
  execFile as execFileCallback,
} from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { windowsPowerShellCommand } from "./platform-environment.mjs";
import { requestError } from "./request-error.js";

const execFile = promisify(execFileCallback);

// The file path is data in an environment variable, never PowerShell source.
// Unlike explorer.exe's process exit, the Shell API reports request failure.
const WINDOWS_SELECT_FILE = `
$ErrorActionPreference = 'Stop'
if ([System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
  throw 'No interactive desktop is available'
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InspireFileManager {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  public static extern int SHParseDisplayName(string name, IntPtr binding, out IntPtr item, uint attrs, out uint result);
  [DllImport("shell32.dll")]
  public static extern int SHOpenFolderAndSelectItems(IntPtr item, uint count, IntPtr children, uint flags);
}
'@
$item = [IntPtr]::Zero
$attrs = [uint32]0
[Runtime.InteropServices.Marshal]::ThrowExceptionForHR([InspireFileManager]::SHParseDisplayName($env:INSPIRE_REVEAL_PATH, [IntPtr]::Zero, [ref]$item, 0, [ref]$attrs))
try {
  [Runtime.InteropServices.Marshal]::ThrowExceptionForHR([InspireFileManager]::SHOpenFolderAndSelectItems($item, 0, [IntPtr]::Zero, 0))
} finally {
  [Runtime.InteropServices.Marshal]::FreeCoTaskMem($item)
}
`;

const WINDOWS_OPEN_DIRECTORY = `
$ErrorActionPreference = 'Stop'
if ([System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
  throw 'No interactive desktop is available'
}
$shell = New-Object -ComObject Shell.Application
try { $shell.Explore($env:INSPIRE_REVEAL_PATH) }
finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
`;

/** Only called with a session-authorized canonical file or directory. */
export async function showInFileManager(
  path: string,
  directory: boolean,
  options: {
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    run?: (
      command: string,
      args: string[],
      options: ExecFileOptions,
    ) => Promise<unknown>;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const run = options.run ?? execFile;
  let command: string;
  let args: string[];
  let env = environment;
  if (platform === "linux") {
    if (!environment.DISPLAY && !environment.WAYLAND_DISPLAY)
      throw requestError("No desktop is available to show this item", 503);
    command = "gdbus";
    args = [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.FileManager1",
      "--object-path",
      "/org/freedesktop/FileManager1",
      "--method",
      `org.freedesktop.FileManager1.${directory ? "ShowFolders" : "ShowItems"}`,
      JSON.stringify([pathToFileURL(path).href]),
      "",
    ];
  } else if (platform === "darwin") {
    command = "/usr/bin/open";
    args = directory ? ["-a", "Finder", path] : ["-R", path];
  } else if (platform === "win32") {
    command = windowsPowerShellCommand(environment);
    args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-Command",
      directory ? WINDOWS_OPEN_DIRECTORY : WINDOWS_SELECT_FILE,
    ];
    env = { ...environment, INSPIRE_REVEAL_PATH: path };
  } else {
    throw requestError(
      "Show in file manager is unsupported on this system",
      501,
    );
  }
  try {
    await run(command, args, {
      env,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw requestError(
      code === "ENOENT"
        ? "The file manager integration is unavailable on this system"
        : "The file manager could not show this item. Check that a desktop session is available.",
      503,
    );
  }
}
