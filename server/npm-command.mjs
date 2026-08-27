import { statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

function existingJavaScriptFile(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    !/\.[cm]?js$/iu.test(path)
  )
    return null;
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

function npmCliCandidates(environment, executable, cwd) {
  const candidates = [];
  if (environment.npm_execpath) {
    candidates.push(
      isAbsolute(environment.npm_execpath)
        ? environment.npm_execpath
        : resolve(cwd, environment.npm_execpath),
    );
  }

  const executableDirectory = dirname(executable);
  candidates.push(
    join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    join(
      dirname(executableDirectory),
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  );

  for (const entry of (environment.PATH ?? environment.Path ?? "").split(
    delimiter,
  )) {
    if (!entry) continue;
    candidates.push(join(entry, "node_modules", "npm", "bin", "npm-cli.js"));
  }
  return [...new Set(candidates)];
}

function powershellCommand(environment) {
  return environment.SystemRoot
    ? join(
        environment.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe";
}

/**
 * Resolve one npm invocation without asking Node to execute a Windows .cmd file
 * directly. A normal Node installation exposes npm-cli.js beside node.exe; a
 * version-manager shim falls back to PowerShell with the argument vector passed
 * through JSON environment data, never interpolated into the script text.
 */
export function npmInvocation(args, suppliedOptions = {}) {
  const platform = suppliedOptions.platform ?? process.platform;
  const environment = suppliedOptions.environment ?? process.env;
  const executable = suppliedOptions.executable ?? process.execPath;
  const cwd = suppliedOptions.cwd ?? process.cwd();
  const invocationArgs = [...args];

  if (platform !== "win32") {
    return { command: "npm", args: invocationArgs, environment };
  }

  const npmCli = npmCliCandidates(environment, executable, cwd)
    .map(existingJavaScriptFile)
    .find(Boolean);
  if (npmCli) {
    return {
      command: executable,
      args: [npmCli, ...invocationArgs],
      environment,
    };
  }

  const commandEnvironment = {
    ...environment,
    INSPIRE_NPM_COMMAND: suppliedOptions.npmCommand ?? "npm.cmd",
    INSPIRE_NPM_ARGUMENTS_JSON: JSON.stringify(invocationArgs),
  };
  return {
    command: powershellCommand(environment),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$ErrorActionPreference = 'Stop'",
        "$npmArgs = @($env:INSPIRE_NPM_ARGUMENTS_JSON | ConvertFrom-Json)",
        "& $env:INSPIRE_NPM_COMMAND @npmArgs",
        "if ($null -eq $LASTEXITCODE) { exit 1 }",
        "exit $LASTEXITCODE",
      ].join("; "),
    ],
    environment: commandEnvironment,
  };
}
