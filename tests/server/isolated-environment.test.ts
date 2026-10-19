import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { windowsPowerShellCommand } from "../../server/platform-environment.mjs";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";

it.each([
  ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "Path"],
  ["SYSTEMROOT", "PROGRAMFILES", "PROGRAMFILES(X86)", "PATH"],
])(
  "preserves Windows OS key spelling (%s) without shadow aliases",
  (systemRoot, programFiles, programFilesX86, path) => {
    const source = {
      [systemRoot]: String.raw`C:\Windows`,
      [programFiles]: String.raw`C:\Program Files`,
      [programFilesX86]: String.raw`C:\Program Files (x86)`,
      [path]: String.raw`C:\Users\real-user\bin`,
      Home: String.raw`C:\Users\real-user`,
      AppData: String.raw`C:\Users\real-user\AppData\Roaming`,
      NODE_OPTIONS: "--require private-user-bootstrap.cjs",
      OPENAI_API_KEY: "synthetic-inherited-key",
      HTTPS_PROXY: "https://private-proxy.invalid",
      PSModulePath: String.raw`C:\Users\real-user\Documents\WindowsPowerShell\Modules`,
      WINDIR: "stale-user-windir",
      SYSTEMDRIVE: "Z:",
      COMSPEC: String.raw`C:\Users\real-user\custom-shell.exe`,
      INSPIRE_BRANCH_WORKER_ID: "old-worker",
    };
    const root = String.raw`C:\isolated-fixture`;
    const environment = isolatedTestEnvironment(
      root,
      {
        INSPIRE_BRANCH_WORKER_ID: "fixture-worker",
      },
      { source, platform: "win32" },
    );
    for (const key of [systemRoot, programFiles, programFilesX86, path]) {
      expect(
        Object.keys(environment).filter(
          (candidate) => candidate.toLowerCase() === key.toLowerCase(),
        ),
      ).toEqual([key]);
    }
    const keys = Object.keys(environment);
    expect(new Set(keys.map((key) => key.toUpperCase())).size).toBe(
      keys.length,
    );
    const child = Object.fromEntries(
      Object.entries({ ...source, ...environment })
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key.toUpperCase(), value]),
    );
    expect(child).toMatchObject({
      SYSTEMROOT: source[systemRoot],
      WINDIR: source[systemRoot],
      SYSTEMDRIVE: "C:",
      COMSPEC: String.raw`C:\Windows\System32\cmd.exe`,
      PSMODULEPATH: String.raw`C:\Program Files\PowerShell\7\Modules`,
      PROGRAMFILES: source[programFiles],
      "PROGRAMFILES(X86)": source[programFilesX86],
      HOME: root,
      USERPROFILE: root,
      APPDATA: String.raw`C:\isolated-fixture\appdata`,
      LOCALAPPDATA: String.raw`C:\isolated-fixture\localappdata`,
      PI_CODING_AGENT_DIR: String.raw`C:\isolated-fixture\agent`,
      PI_CODING_AGENT_SESSION_DIR: String.raw`C:\isolated-fixture\sessions`,
      TMP: root,
      INSPIRE_BRANCH_WORKER_ID: "fixture-worker",
    });
    expect(child.PATH).toContain(String.raw`C:\Windows\System32`);
    expect(child.PATH).not.toContain("real-user");
    expect(child.PSMODULEPATH).not.toContain("real-user");
    for (const key of ["NODE_OPTIONS", "OPENAI_API_KEY", "HTTPS_PROXY"])
      expect(child).not.toHaveProperty(key);
  },
);

it("isolates POSIX user state and launch configuration while retaining explicit fixture overrides", () => {
  const source = {
    HOME: "/real-home",
    PATH: "/private-bin",
    ProgramFiles: "/not-an-os-variable-here",
    NODE_OPTIONS: "--require private-bootstrap.cjs",
    PI_CODING_AGENT_DIR: "/real-agent",
    INSPIRE_BRANCH_COMMAND: "old-command",
  };
  const environment = isolatedTestEnvironment(
    "/fixture",
    {
      PI_CODING_AGENT_DIR: "/fixture/config",
      INSPIRE_BRANCH_COMMAND: "fixture-command",
    },
    { source, platform: "linux" },
  );
  const child = Object.fromEntries(
    Object.entries({ ...source, ...environment }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  expect(child).toMatchObject({
    HOME: "/fixture",
    XDG_CONFIG_HOME: "/fixture/config",
    XDG_DATA_HOME: "/fixture/data",
    XDG_STATE_HOME: "/fixture/state",
    TMPDIR: "/fixture",
    PI_CODING_AGENT_DIR: "/fixture/config",
    INSPIRE_BRANCH_COMMAND: "fixture-command",
    PI_OFFLINE: "1",
  });
  expect(child.PATH).not.toContain("private-bin");
  expect(child).not.toHaveProperty("NODE_OPTIONS");
  expect(child).not.toHaveProperty("ProgramFiles");
});

it.runIf(process.platform === "win32")(
  "loads PowerShell 7 built-in providers, cmdlets and Add-Type in the isolated runtime",
  async ({ signal }) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "inspire-ps-runtime-")),
    );
    try {
      const env = isolatedTestEnvironment(root);
      const systemRoot = Object.entries(env).find(
        ([key]) => key.toLowerCase() === "systemroot",
      )?.[1];
      if (!systemRoot) throw new Error("The Windows runtime has no SystemRoot");
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "[Console]::Error.WriteLine('phase: filesystem provider')",
        "$directory = Microsoft.PowerShell.Management\\Get-Item -LiteralPath $env:SystemRoot",
        "[Console]::Error.WriteLine('phase: direct CLR')",
        "$self = [System.Diagnostics.Process]::GetCurrentProcess().Id",
        "[Console]::Error.WriteLine('phase: process cmdlet')",
        "$id = (Microsoft.PowerShell.Management\\Get-Process -Id $PID -ErrorAction Stop).Id",
        "[Console]::Error.WriteLine('phase: Add-Type')",
        "Microsoft.PowerShell.Utility\\Add-Type -TypeDefinition 'public static class FixtureRuntime { public static int Answer() { return 42; } }'",
        "[Console]::Error.WriteLine('phase: JSON cmdlets')",
        "$proof = @{ directory=$directory.PSIsContainer; process=$id; self=$self; answer=[FixtureRuntime]::Answer() }",
        "$roundtrip = Microsoft.PowerShell.Utility\\ConvertFrom-Json -InputObject ($proof | Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress)",
        "[Console]::Out.WriteLine(($roundtrip | Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress))",
      ].join("\n");
      let stdout: string;
      try {
        ({ stdout } = await promisify(execFileCallback)(
          windowsPowerShellCommand(env),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          {
            env,
            signal,
            encoding: "utf8",
            timeout: 10_000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
          },
        ));
      } catch (error) {
        const failure = error as Error & { stderr?: string };
        throw new Error(
          "Isolated PowerShell runtime failed: " +
            (failure.stderr || failure.message).slice(0, 16 * 1024),
          { cause: error },
        );
      }
      const proof = JSON.parse(stdout);
      expect(proof.directory).toBe(true);
      expect(proof.process).toBe(proof.self);
      expect(proof.process).toBeGreaterThan(0);
      expect(proof.answer).toBe(42);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
