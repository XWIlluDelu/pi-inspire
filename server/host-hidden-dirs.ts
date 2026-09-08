import { execFile as execFileCallback } from "node:child_process";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import { basename, win32 } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
type AttributeCommand = (
  command: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string }>;

/** Node's Dirent/Stats do not expose Windows Hidden or macOS UF_HIDDEN.
 * Read these attributes once per level, without a shell or recursive scan.
 * Dot-prefixed names are handled separately on every host platform. */
export async function listNativeHiddenNames(
  path: string,
  platform: NodeJS.Platform = process.platform,
  run: AttributeCommand = execFile,
): Promise<Set<string>> {
  if (platform !== "win32" && platform !== "darwin") return new Set();
  const options: ExecFileOptionsWithStringEncoding = {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  };
  try {
    if (platform === "darwin") {
      const { stdout } = await run(
        "/usr/bin/find",
        [
          path,
          "-mindepth",
          "1",
          "-maxdepth",
          "1",
          "-flags",
          "+hidden",
          "-print0",
        ],
        options,
      );
      return new Set(
        stdout
          .split("\0")
          .filter(Boolean)
          .map((entry) => basename(entry)),
      );
    }
    const { stdout } = await run(
      win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$ErrorActionPreference = 'Stop'",
          "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
          "ConvertTo-Json -Compress -InputObject @(Get-ChildItem -LiteralPath $env:INSPIRE_DIRECTORY_PATH -Force -Hidden | Select-Object -ExpandProperty Name)",
        ].join("; "),
      ],
      { ...options, env: { ...process.env, INSPIRE_DIRECTORY_PATH: path } },
    );
    const names: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    if (
      !Array.isArray(names) ||
      !names.every((name) => typeof name === "string")
    )
      throw new Error("Invalid hidden-folder attribute response");
    return new Set(names);
  } catch (cause) {
    // Do not silently show native-hidden entries when attribute inspection
    // fails. Show hidden folders deliberately bypasses this inspection.
    throw new Error("Cannot read hidden-folder attributes on the host", {
      cause,
    });
  }
}
