import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { basename, isAbsolute } from "node:path";
import { isolatedProcessOptions, signalProcessTree } from "./process-tree.mjs";

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "ksh93"]);
const PROBE_KEYS = [
  "PWD", "OLDPWD", "SHLVL", "_", "TERM", "INSPIRE_RESOLVING_ENVIRONMENT",
];
const SERVICE_KEYS = [
  "SYSTEMD_EXEC_PID",
  "INVOCATION_ID",
  "NOTIFY_SOCKET",
  "JOURNAL_STREAM",
  "LISTEN_PID",
  "LISTEN_FDS",
  "LISTEN_FDNAMES",
];

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function environmentError(reason) {
  // Shell output and environment values may contain credentials. Never include
  // either in the error (which can reach the service journal).
  return new Error(
    `Unable to load the user shell environment: ${reason}. Fix shell startup, ` +
    "select a supported shell with INSPIRE_SHELL, or set INSPIRE_ENVIRONMENT=inherit " +
    "and configure the service environment explicitly.",
  );
}

function parseEnvironment(bytes) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    for (const [key, entry] of Object.entries(value)) {
      if (
        !key || /[=\0]/u.test(key) ||
        typeof entry !== "string" || entry.includes("\0")
      ) throw new Error();
    }
    if (!value.PATH) throw new Error();
    return value;
  } catch {
    throw environmentError(
      "the shell did not return a valid exported environment",
    );
  }
}

async function shellEnvironment(environment, options) {
  const shell = environment.INSPIRE_SHELL || environment.SHELL ||
    userInfo().shell || "/bin/sh";
  if (!isAbsolute(shell) || !SHELLS.has(basename(shell)))
    throw environmentError(
      "the selected shell is not a supported absolute shell path",
    );
  const script = 'process.stdout.write(JSON.stringify(process.env))';
  // Interactive Bash can mark inherited auxiliary descriptors close-on-exec.
  // Duplicate the dedicated pipe to stdout only for this final export command.
  const command = `exec ${shellQuote(process.execPath)} -e ${shellQuote(script)} 1>&3`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(shell, ["-i", "-l", "-c", command], {
      cwd: environment.HOME || userInfo().homedir,
      env: {
        ...environment,
        SHELL: shell,
        TERM: environment.TERM || "dumb",
        INSPIRE_RESOLVING_ENVIRONMENT: "1",
      },
      ...isolatedProcessOptions(),
      // A separate pipe keeps banners, prompts, and startup warnings out of the
      // environment protocol. No startup output or environment is persisted.
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const chunks = [];
    let length = 0;
    let settled = false;
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void signalProcessTree(child, "SIGKILL", { isolated: true });
      child.stdio[3]?.destroy();
      reject(environmentError(reason));
    };
    const timer = setTimeout(
      () => fail("shell initialization timed out"),
      options.timeoutMs ?? 10_000,
    );
    child.stdio[3].on("data", (chunk) => {
      length += chunk.length;
      if (length > (options.maxBytes ?? 1024 * 1024)) {
        fail("the exported environment exceeded the size limit");
        return;
      }
      chunks.push(chunk);
    });
    child.stdio[3].on("error", () => fail("the environment pipe failed"));
    child.once("error", () => fail("the shell could not be started"));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail("shell initialization failed");
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        resolve(parseEnvironment(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });
  });

  // Shell unsets are meaningful: do not merge the entire incoming environment
  // back in. Retain only launcher/service authority and discard probe state.
  for (const key of new Set([
    ...PROBE_KEYS,
    ...SERVICE_KEYS,
    ...Object.keys(environment).filter((key) => key.startsWith("INSPIRE_")),
  ])) {
    if (environment[key] === undefined) delete result[key];
    else result[key] = environment[key];
  }
  // Resolve once at the launch boundary. Children and nested launchers inherit
  // the result rather than repeatedly running interactive initialization.
  result.INSPIRE_ENVIRONMENT = "inherit";
  return result;
}

/** Direct launches inherit their caller. Service launches acquire the user's
 * exported login/interactive shell environment, not a frozen install-time PATH. */
export async function resolveLaunchEnvironment(
  environment = process.env,
  options = {},
) {
  const mode = environment.INSPIRE_ENVIRONMENT ||
    (options.service ? "shell" : "inherit");
  if (mode === "inherit") return { ...environment };
  if (mode !== "shell")
    throw environmentError("INSPIRE_ENVIRONMENT must be inherit or shell");
  if ((options.platform ?? process.platform) === "win32")
    throw environmentError("shell environment discovery is POSIX-only");
  return shellEnvironment(environment, options);
}

/** Copy named variables through systemd-run without putting their values in argv.
 * systemd supplies its own invocation/notification identity to the new service. */
export function systemdEnvironmentArguments(environment) {
  return Object.keys(environment)
    .filter((key) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) &&
      environment[key] !== undefined && !SERVICE_KEYS.includes(key),
    )
    .map((key) => `--setenv=${key}`);
}
