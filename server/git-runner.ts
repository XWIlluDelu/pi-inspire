import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedProcessOptions, signalProcessTree } from "./process-tree.mjs";

export const GIT_TIMEOUT_MS = 4_000;
export const GIT_STDERR_BYTES = 64 * 1024;
export const GIT_CONFIG_ARGS = [
  "--no-optional-locks",
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=",
  "-c",
  "core.askPass=",
  "-c",
  "diff.external=",
  "-c",
  "diff.suppressBlankEmpty=false",
] as const;

export interface GitRunOptions {
  stdoutLimit: number;
  allowStdoutTruncation?: boolean;
  acceptedExitCodes?: readonly number[];
  signal?: AbortSignal;
  timeoutMs?: number;
  stderrLimit?: number;
}
export interface GitRunResult {
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
  code: number;
}
export type GitRunner = (
  args: readonly string[],
  options: GitRunOptions,
) => Promise<GitRunResult>;

export class GitInspectionError extends Error {
  status: number;
  detail?: string;
  exitCode?: number;
  constructor(
    message: string,
    status = 502,
    detail?: string,
    exitCode?: number,
  ) {
    super(message);
    this.name = "GitInspectionError";
    this.status = status;
    this.detail = detail;
    this.exitCode = exitCode;
  }
}

function gitEnvironment(configurationDiscovery = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // These variables locate data-only global attributes and excludes too.
  for (const key of [
    "HOME",
    "XDG_CONFIG_HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "PROGRAMDATA",
    "ALLUSERSPROFILE",
    "APPDATA",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (configurationDiscovery) {
    for (const [key, value] of Object.entries(process.env)) {
      if (/^GIT_CONFIG_/iu.test(key)) env[key.toUpperCase()] = value;
    }
  }
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    ...env,
    LC_ALL: "C",
    LANG: "C",
    ...(!configurationDiscovery
      ? {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: nullDevice,
          GIT_CONFIG_SYSTEM: nullDevice,
        }
      : {}),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
  };
}

const spawnGitProcess = (
  args: readonly string[],
  options: GitRunOptions,
  environment: NodeJS.ProcessEnv,
): Promise<GitRunResult> =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new GitInspectionError("Git inspection was cancelled", 499));
      return;
    }
    const child = spawn("git", [...args], {
      shell: false,
      ...isolatedProcessOptions(),
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let outputFailed = false;
    let settled = false;
    const stderrLimit = options.stderrLimit ?? GIT_STDERR_BYTES;
    let killStarted = false;
    const kill = () => {
      if (killStarted) return;
      killStarted = true;
      void signalProcessTree(child, "SIGKILL", { isolated: true });
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // AbortSignal does not replay an abort that races between the initial
    // check and listener registration. Recheck after subscribing so every
    // cancellation is either delivered or observed here.
    if (options.signal?.aborted) onAbort();
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const failPipe = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      kill();
      reject(
        new GitInspectionError(
          "Git inspection output could not be read",
          502,
          error.message,
        ),
      );
    };
    child.stdout.on("error", failPipe);
    child.stdout.on("data", (value: Buffer) => {
      const room = options.stdoutLimit - stdoutBytes;
      if (value.length > room) {
        if (room > 0) stdout.push(value.subarray(0, room));
        stdoutBytes += Math.max(0, room);
        truncated = true;
        if (!options.allowStdoutTruncation) outputFailed = true;
        kill();
      } else {
        stdout.push(value);
        stdoutBytes += value.length;
      }
    });
    child.stderr.on("error", failPipe);
    child.stderr.on("data", (value: Buffer) => {
      const room = stderrLimit - stderrBytes;
      if (room > 0) stderr.push(value.subarray(0, room));
      stderrBytes += value.length;
      if (stderrBytes > stderrLimit) {
        outputFailed = true;
        kill();
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new GitInspectionError(
          error.code === "ENOENT"
            ? "Git is not available on this host"
            : "Git could not be started",
          error.code === "ENOENT" ? 503 : 502,
          error.message,
        ),
      );
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stderrBuffer = Buffer.concat(stderr);
      if (aborted) {
        reject(new GitInspectionError("Git inspection was cancelled", 499));
        return;
      }
      if (timedOut) {
        reject(
          new GitInspectionError(
            "Git inspection timed out",
            503,
            stderrBuffer.toString("utf8"),
          ),
        );
        return;
      }
      if (outputFailed) {
        reject(
          new GitInspectionError(
            "Git inspection output exceeded its safety limit",
            502,
            stderrBuffer.toString("utf8"),
          ),
        );
        return;
      }
      const numericCode = code ?? -1;
      if (
        !(truncated && options.allowStdoutTruncation) &&
        !(options.acceptedExitCodes ?? [0]).includes(numericCode)
      ) {
        reject(
          new GitInspectionError(
            signal ? "Git inspection was terminated" : "Git inspection failed",
            502,
            stderrBuffer.toString("utf8"),
            numericCode,
          ),
        );
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: stderrBuffer,
        truncated,
        code: numericCode,
      });
    });
  });

export const spawnGit: GitRunner = (args, options) =>
  spawnGitProcess(args, options, gitEnvironment());

const SAFE_CORE_SETTINGS = [
  "autocrlf",
  "eol",
  "safecrlf",
  "filemode",
  "ignorecase",
  "symlinks",
  "precomposeunicode",
  "checkstat",
  "trustctime",
  "attributesfile",
  "excludesfile",
] as const;
const CONFIGURATION_PATTERN = `^(core\\.(${SAFE_CORE_SETTINGS.join("|")})|safe\\.directory|filter\\..*\\.(clean|smudge|process|required))$`;

type ConfigValue = string | undefined;
interface InspectionConfiguration {
  data: Map<string, ConfigValue>;
  directories: ConfigValue[];
  command: string[];
  drivers: Map<string, boolean>;
  signature: string;
}

function configArgument(key: string, value: ConfigValue): string {
  return value === undefined ? key : key + "=" + value;
}

function inspectionConfiguration(output: Buffer): InspectionConfiguration {
  const data = new Map<string, ConfigValue>();
  const commandValues = new Map<string, ConfigValue>();
  const directories: ConfigValue[] = [],
    commandDirectories: ConfigValue[] = [];
  const conversions = new Map<string, ConfigValue>();
  const names = new Set<string>();
  if (output.length && output.at(-1) !== 0)
    throw new GitInspectionError("Git returned incomplete configuration data");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new GitInspectionError("Git configuration is not valid UTF-8");
  }
  const records = text.split("\0").slice(0, -1);
  if (records.length % 2)
    throw new GitInspectionError(
      "Git returned incomplete configuration scopes",
    );
  for (let index = 0; index < records.length; index += 2) {
    const scope = records[index]!,
      record = records[index + 1]!;
    const separator = record.indexOf("\n");
    const key = separator < 0 ? record : record.slice(0, separator);
    const value = separator < 0 ? undefined : record.slice(separator + 1);
    if (key === "safe.directory") {
      if (scope === "system" || scope === "global") directories.push(value);
      else if (scope === "command") commandDirectories.push(value);
      continue; // Local/worktree declarations must not become protected trust.
    }
    const driver = /^filter\.(.+)\.(clean|smudge|process|required)$/u.exec(key);
    if (driver) {
      names.add(driver[1]!);
      conversions.set(key, value);
    } else if (!SAFE_CORE_SETTINGS.some((name) => key === "core." + name)) {
      throw new GitInspectionError(
        "Git returned unsupported configuration data",
      );
    }
    // Commands are never copied into the safe data file.
    if (!driver || driver[2] === "required") {
      if (scope === "system" || scope === "global") data.set(key, value);
      else if (scope === "command") commandValues.set(key, value);
    }
  }
  const command: string[] = [];
  for (const directory of commandDirectories)
    command.push("-c", configArgument("safe.directory", directory));
  for (const [key, value] of commandValues)
    command.push("-c", configArgument(key, value));
  const drivers = new Map(
    [...names].map((name) => [
      name,
      !!(
        conversions.get("filter." + name + ".clean") ||
        conversions.get("filter." + name + ".process")
      ),
    ]),
  );
  return {
    data,
    directories,
    command,
    drivers,
    signature: JSON.stringify({
      data: [...data].sort(([a], [b]) => a.localeCompare(b)),
      directories,
      command,
    }),
  };
}

function quotedConfig(value: string): string {
  return (
    '"' +
    value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\n", "\\n")
      .replaceAll("\t", "\\t")
      .replaceAll("\b", "\\b") +
    '"'
  );
}

function configurationFile(configuration: InspectionConfiguration): string {
  const entries: Array<[string, ConfigValue]> = [
    ...configuration.data,
    ...configuration.directories.map((value): [string, ConfigValue] => [
      "safe.directory",
      value,
    ]),
  ];
  return entries
    .map(([key, value]) => {
      const first = key.indexOf("."),
        last = key.lastIndexOf(".");
      const section = key.slice(0, first);
      const subsection =
        first === last ? "" : " " + quotedConfig(key.slice(first + 1, last));
      return (
        "[" +
        section +
        subsection +
        "]\n\t" +
        key.slice(last + 1) +
        (value === undefined ? "" : " = " + quotedConfig(value)) +
        "\n"
      );
    })
    .join("");
}

function driverArguments(drivers: ReadonlyMap<string, boolean>): string[] {
  const args: string[] = [];
  for (const [name, conversion] of drivers) {
    for (const method of ["clean", "smudge", "process"])
      args.push("-c", "filter." + name + "." + method + "=");
    if (conversion) args.push("-c", "filter." + name + ".required=true");
  }
  return args;
}

const CONFIG_QUERY = [
  "config",
  "--null",
  "--show-scope",
  "--includes",
  "--get-regexp",
  CONFIGURATION_PATTERN,
];
const MODULE_BOUNDARY = "\0INSPIRE_CONFIG_BOUNDARY\0";
const shellQuote = (value: string): string =>
  "'" + value.replaceAll("'", "'\\''") + "'";
const MODULE_QUERY =
  "printf '\\000INSPIRE_CONFIG_BOUNDARY\\000'; " +
  ["git", ...GIT_CONFIG_ARGS, "rev-parse", "--git-dir"]
    .map(shellQuote)
    .join(" ") +
  " >/dev/null && (" +
  ["git", ...GIT_CONFIG_ARGS, ...CONFIG_QUERY].map(shellQuote).join(" ") +
  " || test $? = 1)";

/** A scoped safe global file preserves native repository/worktree precedence,
 * including subprocesses inspecting submodules. Call close after the operation. */
export function createGitInspectionRunner(
  cwd: string,
): GitRunner & { close(): Promise<void> } {
  let directory: string | undefined;
  let configuration:
    | Promise<{ settings: InspectionConfiguration; file: string }>
    | undefined;
  let modules: Promise<void> | undefined;
  const pending = new Set<Promise<GitRunResult>>();
  let closed = false;
  const runner: GitRunner = (args, options) => {
    if (closed)
      return Promise.reject(
        new GitInspectionError("Git inspection is closed", 499),
      );
    const job = (async () => {
      const started = performance.now(),
        budget = options.timeoutMs ?? GIT_TIMEOUT_MS;
      const remaining = () => {
        const value = budget - (performance.now() - started);
        if (value <= 0)
          throw new GitInspectionError("Git inspection timed out", 503);
        return value;
      };
      configuration ??= (async () => {
        const result = await spawnGitProcess(
          [...GIT_CONFIG_ARGS, "-C", cwd, ...CONFIG_QUERY],
          {
            stdoutLimit: GIT_STDERR_BYTES,
            acceptedExitCodes: [0, 1],
            signal: options.signal,
            timeoutMs: remaining(),
          },
          gitEnvironment(true),
        );
        const settings = inspectionConfiguration(result.stdout);
        directory = await mkdtemp(join(tmpdir(), "inspire-git-inspection-"));
        const file = join(directory, "global.config");
        await writeFile(file, configurationFile(settings), { mode: 0o600 });
        return { settings, file };
      })();
      const { settings, file } = await configuration;
      if (args[args.indexOf("-C") + 2] === "status") {
        modules ??= (async () => {
          const result = await spawnGitProcess(
            [
              ...GIT_CONFIG_ARGS,
              "-C",
              cwd,
              "submodule",
              "foreach",
              "--quiet",
              "--recursive",
              MODULE_QUERY,
            ],
            {
              stdoutLimit: GIT_STDERR_BYTES,
              signal: options.signal,
              timeoutMs: remaining(),
            },
            gitEnvironment(true),
          );
          // Boundary records cannot be confused with config scopes/keys. Empty
          // config (exit 1) is valid even for an initialized module.
          let output: string;
          try {
            output = new TextDecoder("utf-8", { fatal: true }).decode(
              result.stdout,
            );
          } catch {
            throw new GitInspectionError(
              "Git configuration is not valid UTF-8",
            );
          }
          for (const block of output.split(MODULE_BOUNDARY).slice(1)) {
            const nested = inspectionConfiguration(Buffer.from(block));
            if (nested.signature !== settings.signature)
              throw new GitInspectionError(
                "Git inspection does not support differing conditional submodule settings",
                422,
              );
            for (const [name, conversion] of nested.drivers)
              settings.drivers.set(
                name,
                conversion || (settings.drivers.get(name) ?? false),
              );
          }
        })();
        await modules;
      }
      return spawnGitProcess(
        [...settings.command, ...driverArguments(settings.drivers), ...args],
        {
          ...options,
          timeoutMs: remaining(),
        },
        { ...gitEnvironment(), GIT_CONFIG_GLOBAL: file },
      ).catch((error: unknown) => {
        if (
          error instanceof GitInspectionError &&
          [...settings.drivers].some(
            ([name, conversion]) =>
              conversion &&
              error.detail?.includes(`clean filter '${name}' failed`),
          )
        )
          throw new GitInspectionError(
            "External content filters are unavailable in read-only Git inspection",
            422,
            error.detail,
            error.exitCode,
          );
        throw error;
      });
    })();
    pending.add(job);
    void job.then(
      () => pending.delete(job),
      () => pending.delete(job),
    );
    return job;
  };
  return Object.assign(runner, {
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  });
}
