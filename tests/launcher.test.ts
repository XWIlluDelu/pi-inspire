import { createServer } from "node:http";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "inspire");
const children: ChildProcess[] = [];
const temporaryDirectories: string[] = [];
let activeEnvironment: NodeJS.ProcessEnv | null = null;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a TCP test server");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

function launcherEnv(
  statePath: string,
  port: number,
  home: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    INSPIRE_HOST: "127.0.0.1",
    INSPIRE_PORT: String(port),
    INSPIRE_STATE_PATH: statePath,
    INSPIRE_OPEN: "0",
  };
}

async function serviceLauncherEnv(
  directory: string,
): Promise<NodeJS.ProcessEnv> {
  const bin = join(directory, "bin");
  const configHome = join(directory, "config");
  const state = join(directory, "service-state");
  const unitFileState = join(directory, "unit-file-state");
  const log = join(directory, "systemctl.log");
  await mkdir(join(configHome, "systemd", "user"), { recursive: true });
  await mkdir(bin);
  await writeFile(state, "inactive\n");
  await writeFile(unitFileState, "enabled\n");
  await writeFile(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_SYSTEMD_LOG"
case "\${2:-}" in
  show)
    active="$(< "$FAKE_SYSTEMD_STATE")"
    unit_file_state="$(< "$FAKE_SYSTEMD_UNIT_FILE_STATE")"
    substate="dead"
    exec_start_post="{ path=$FAKE_SYSTEMD_ROOT/inspire ; argv[]=$FAKE_SYSTEMD_ROOT/inspire wait-ready ; }"
    [[ "$active" == "active" ]] && substate="running"
    [[ "\${FAKE_SYSTEMD_OUTDATED:-0}" == "1" ]] && exec_start_post=""
    printf '%s\\n' \\
      'LoadState=loaded' \\
      "FragmentPath=$XDG_CONFIG_HOME/systemd/user/inspire-host.service" \\
      "WorkingDirectory=$FAKE_SYSTEMD_ROOT" \\
      "ExecStart={ path=$FAKE_SYSTEMD_ROOT/inspire ; argv[]=$FAKE_SYSTEMD_ROOT/inspire ; }" \\
      "ExecStartPost=$exec_start_post" \
      "UnitFileState=$unit_file_state" \\
      "ActiveState=$active" \\
      "SubState=$substate"
    ;;
  start|restart)
    printf 'active\\n' > "$FAKE_SYSTEMD_STATE"
    ;;
  stop)
    printf 'inactive\\n' > "$FAKE_SYSTEMD_STATE"
    ;;
  enable)
    printf 'active\\n' > "$FAKE_SYSTEMD_STATE"
    printf 'enabled\\n' > "$FAKE_SYSTEMD_UNIT_FILE_STATE"
    ;;
  disable)
    printf 'inactive\\n' > "$FAKE_SYSTEMD_STATE"
    printf 'disabled\\n' > "$FAKE_SYSTEMD_UNIT_FILE_STATE"
    ;;
  daemon-reload)
    ;;
  *)
    printf 'unexpected systemctl invocation: %s\\n' "$*" >&2
    exit 64
    ;;
esac
`,
  );
  await chmod(join(bin, "systemctl"), 0o755);

  const environment = { ...process.env };
  for (const key of [
    "INSPIRE_HOST",
    "INSPIRE_MOCK",
    "INSPIRE_PORT",
    "INSPIRE_STATE_PATH",
    "INSPIRE_TOKEN",
  ]) {
    delete environment[key];
  }
  return {
    ...environment,
    HOME: join(directory, "home"),
    XDG_CONFIG_HOME: configHome,
    XDG_RUNTIME_DIR: join(directory, "runtime"),
    PATH: `${bin}:${environment.PATH ?? ""}`,
    INSPIRE_OPEN: "0",
    FAKE_SYSTEMD_LOG: log,
    FAKE_SYSTEMD_ROOT: root,
    FAKE_SYSTEMD_STATE: state,
    FAKE_SYSTEMD_UNIT_FILE_STATE: unitFileState,
  };
}

function runLauncher(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(launcher, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for isolated launcher acceptance");
}

afterEach(async () => {
  if (activeEnvironment) {
    try {
      runLauncher(["stop"], activeEnvironment);
    } catch {
      // The child may already have exited; cleanup below still removes only
      // this test's temporary directory.
    }
    activeEnvironment = null;
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("production launcher", () => {
  it("delegates a matching installed host service through systemd", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-systemd-"));
    temporaryDirectories.push(directory);
    const environment = await serviceLauncherEnv(directory);

    expect(runLauncher([], environment)).toContain(
      "Started INSΠRE system service.",
    );
    expect(runLauncher(["service", "status-host"], environment)).toContain(
      "INSΠRE system service is running (enabled).",
    );
    expect(() => runLauncher(["status"], environment)).toThrow(
      /Host is not reachable/u,
    );
    expect(runLauncher(["restart"], environment)).toContain(
      "Restarted INSΠRE system service.",
    );
    expect(runLauncher(["stop"], environment)).toContain(
      "Stopped INSΠRE system service.",
    );
    expect(runLauncher(["service", "enable-host"], environment)).toContain(
      "Enabled and started (with daily idle maintenance) INSΠRE system service.",
    );
    expect(runLauncher(["service", "disable-host"], environment)).toContain(
      "Disabled and stopped (with daily idle maintenance) INSΠRE system service.",
    );
    const log = await readFile(environment.FAKE_SYSTEMD_LOG!, "utf8");
    expect(log).toContain("--user start inspire-host.service");
    expect(log).toContain("--user restart inspire-host.service");
    expect(log).toContain("--user stop inspire-host.service");
    expect(log).toContain("--user enable --now inspire-host.service");
    expect(log).toContain("--user disable --now inspire-host.service");
    expect(log).toContain(
      "--user enable --now inspire-idle-maintenance-restart.timer",
    );
    expect(log).toContain(
      "--user disable --now inspire-idle-maintenance-restart.timer",
    );
  });

  it("installs a readiness-gated host unit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-systemd-install-"));
    temporaryDirectories.push(directory);
    const environment = await serviceLauncherEnv(directory);

    expect(runLauncher(["service", "install-host"], environment)).toContain(
      "Installed",
    );
    const unit = await readFile(
      join(
        environment.XDG_CONFIG_HOME!,
        "systemd",
        "user",
        "inspire-host.service",
      ),
      "utf8",
    );
    expect(unit).toContain(`ExecStartPost=${launcher} wait-ready`);
    expect(unit).toContain("TimeoutStartSec=5min");
  });

  it("rejects an installed host unit without the readiness gate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-systemd-old-"));
    temporaryDirectories.push(directory);
    const environment = await serviceLauncherEnv(directory);
    environment.FAKE_SYSTEMD_OUTDATED = "1";

    expect(() => runLauncher(["status"], environment)).toThrow(
      /unit is outdated/u,
    );
  });

  it("keeps explicit local instances out of systemd delegation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-direct-"));
    temporaryDirectories.push(directory);
    const environment = await serviceLauncherEnv(directory);
    environment.INSPIRE_HOST = "127.0.0.1";
    environment.INSPIRE_PORT = "4589";
    environment.INSPIRE_STATE_PATH = join(directory, "instance.json");

    expect(() => runLauncher(["status"], environment)).toThrow();
    await expect(
      readFile(environment.FAKE_SYSTEMD_LOG!, "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restarts without an existing instance and owns one isolated lifecycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-launcher-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "instance.json");
    const port = await freePort();
    const env = launcherEnv(statePath, port, join(directory, "home"));
    expect(runLauncher(["stop"], env)).toContain(
      "No managed INSΠRE instance is running.",
    );
    // CI builds the browser before its parallel unit suite. Remove only this
    // source-checkout stamp so this serial lifecycle test still proves that a
    // stale build is rebuilt once, without competing with all Vitest workers.
    await rm(join(root, ".inspire-build"), { force: true });
    const output: Buffer[] = [];
    const child = spawn(launcher, ["restart"], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeEnvironment = env;
    children.push(child);
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));

    await waitFor(() => {
      try {
        return runLauncher(["status"], env).startsWith("INSΠRE is running.");
      } catch {
        return false;
      }
    });
    const firstState = JSON.parse(await readFile(statePath, "utf8")) as {
      schemaVersion: number;
      token: string;
    };
    expect(firstState.schemaVersion).toBe(1);
    expect(runLauncher(["wait-ready"], env)).toBe("");
    expect(Buffer.concat(output).toString()).toContain(
      "No managed INSΠRE instance is running.",
    );

    const stopOutput = runLauncher(["stop"], env);
    expect(stopOutput).toContain("Stopped INSΠRE process");
    const exitCode = await new Promise<number | null>((resolveExit) =>
      child.once("close", (code) => resolveExit(code)),
    );
    expect(exitCode).toBe(0);
    activeEnvironment = null;
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const restarted = spawn(launcher, ["start"], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeEnvironment = env;
    children.push(restarted);
    await waitFor(() => {
      try {
        return runLauncher(["status"], env).startsWith("INSΠRE is running.");
      } catch {
        return false;
      }
    });
    const secondState = JSON.parse(await readFile(statePath, "utf8")) as {
      token: string;
    };
    expect(secondState.token).toBe(firstState.token);
    expect(runLauncher(["stop"], env)).toContain("Stopped INSΠRE process");
    const restartedExit =
      restarted.exitCode ??
      (await new Promise<number | null>((resolveExit) =>
        restarted.once("close", resolveExit),
      ));
    expect(restartedExit).toBe(0);
    activeEnvironment = null;
  }, 120_000);
});
