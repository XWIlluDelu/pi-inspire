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
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defaultStaticAssetCacheDirectory } from "../server/static-asset-cache.mjs";
import { TerminalDaemonClient } from "../server/terminal-daemon-client.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "inspire.mjs");
const unixLauncher = join(root, "inspire");
const linuxIt = process.platform === "linux" ? it : it.skip;
const children: ChildProcess[] = [];
const temporaryDirectories: string[] = [];
const terminalEnvironments: NodeJS.ProcessEnv[] = [];
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
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(home, "runtime"),
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
    [[ "$active" == "active" ]] && substate="running"
    if [[ "\${3:-}" == "inspire-terminal.service" ]]; then
      printf '%s\\n' \\
        'LoadState=loaded' \\
        "FragmentPath=$XDG_CONFIG_HOME/systemd/user/inspire-terminal.service" \\
        "WorkingDirectory=$FAKE_SYSTEMD_ROOT" \\
        "ExecStart={ path=$FAKE_SYSTEMD_ROOT/inspire ; argv[]=$FAKE_SYSTEMD_ROOT/inspire terminal-daemon --root $FAKE_SYSTEMD_ROOT --host 127.0.0.1 --port 4587 ; }"
    else
      exec_start_post="{ path=$FAKE_SYSTEMD_ROOT/inspire ; argv[]=$FAKE_SYSTEMD_ROOT/inspire wait-ready ; }"
      [[ "\${FAKE_SYSTEMD_OUTDATED:-0}" == "1" ]] && exec_start_post=""
      printf '%s\\n' \\
        'LoadState=loaded' \\
        "FragmentPath=$XDG_CONFIG_HOME/systemd/user/inspire-host.service" \\
        "WorkingDirectory=$FAKE_SYSTEMD_ROOT" \\
        "ExecStart={ path=$FAKE_SYSTEMD_ROOT/inspire ; argv[]=$FAKE_SYSTEMD_ROOT/inspire ; }" \\
        "ExecStartPost=$exec_start_post" \
        'Wants=inspire-terminal.service network-online.target' \\
        "UnitFileState=$unit_file_state" \\
        "ActiveState=$active" \\
        "SubState=$substate"
    fi
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
    PATH: `${bin}${delimiter}${environment.PATH ?? ""}`,
    INSPIRE_OPEN: "0",
    FAKE_SYSTEMD_LOG: log,
    FAKE_SYSTEMD_ROOT: root,
    FAKE_SYSTEMD_STATE: state,
    FAKE_SYSTEMD_UNIT_FILE_STATE: unitFileState,
  };
}

function runLauncher(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, [launcher, ...args], {
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
  for (const environment of terminalEnvironments.splice(0)) {
    try {
      const address = environment.INSPIRE_TERMINAL_DAEMON_ADDRESS!;
      const token = (
        await readFile(environment.INSPIRE_TERMINAL_TOKEN_PATH!, "utf8")
      ).trim();
      await new TerminalDaemonClient(address, token).requestProtocolReplacement(
        0,
      );
    } catch {
      // A launch that failed before starting its terminal daemon needs no stop.
    }
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("production launcher", () => {
  linuxIt(
    "delegates a matching installed host service through systemd",
    async () => {
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
      expect(log).toContain("--user enable --now inspire-terminal.service");
      expect(log).toContain("--user disable --now inspire-terminal.service");
      expect(log).toContain(
        "--user enable --now inspire-idle-maintenance-restart.timer",
      );
      expect(log).toContain(
        "--user disable --now inspire-idle-maintenance-restart.timer",
      );
    },
  );

  linuxIt("installs a readiness-gated host unit", async () => {
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
    expect(unit).toContain(`ExecStartPost=${unixLauncher} wait-ready`);
    expect(unit).toContain(
      "Wants=network-online.target inspire-terminal.service",
    );
    expect(unit).toContain("TimeoutStartSec=5min");
    const terminalUnit = await readFile(
      join(
        environment.XDG_CONFIG_HOME!,
        "systemd",
        "user",
        "inspire-terminal.service",
      ),
      "utf8",
    );
    expect(terminalUnit).toContain(
      `ExecStart=${unixLauncher} terminal-daemon --root ${root}`,
    );
  });

  it("stops the readiness wait when the service process exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-systemd-ready-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "instance.json");
    const port = await freePort();
    const environment = {
      ...launcherEnv(statePath, port, join(directory, "home")),
      MAINPID: "999999999",
    };

    expect(() => runLauncher(["wait-ready"], environment)).toThrow(
      /Host process exited before becoming ready/u,
    );
  });

  linuxIt(
    "rejects an installed host unit without the readiness gate",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inspire-systemd-old-"));
      temporaryDirectories.push(directory);
      const environment = await serviceLauncherEnv(directory);
      environment.FAKE_SYSTEMD_OUTDATED = "1";

      expect(() => runLauncher(["status"], environment)).toThrow(
        /unit is outdated/u,
      );
    },
  );

  it("keeps explicit local instances out of systemd delegation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-direct-"));
    temporaryDirectories.push(directory);
    const environment =
      process.platform === "linux"
        ? await serviceLauncherEnv(directory)
        : launcherEnv(
            join(directory, "instance.json"),
            4589,
            join(directory, "home"),
          );
    environment.INSPIRE_HOST = "127.0.0.1";
    environment.INSPIRE_PORT = "4589";
    environment.INSPIRE_STATE_PATH = join(directory, "instance.json");

    expect(() => runLauncher(["status"], environment)).toThrow();
    if (process.platform === "linux") {
      await expect(
        readFile(environment.FAKE_SYSTEMD_LOG!, "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it.runIf(process.platform !== "linux")(
    "keeps Linux system-service commands explicit on other systems",
    () => {
      const environment = { ...process.env, INSPIRE_OPEN: "0" };
      expect(() =>
        runLauncher(["service", "status-host"], environment),
      ).toThrow(/require Linux systemd/u);
    },
  );

  it("restarts without an existing instance and owns one isolated lifecycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-launcher-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "instance.json");
    const port = await freePort();
    const home = join(directory, "home");
    const env = launcherEnv(statePath, port, home);
    env.INSPIRE_TERMINAL_DAEMON_ADDRESS =
      process.platform === "win32"
        ? `\\\\.\\pipe\\inspire-terminal-launcher-${port}`
        : join(directory, "terminal.sock");
    env.INSPIRE_TERMINAL_TOKEN_PATH = join(directory, "terminal-token");
    env.INSPIRE_TERMINAL_STATE_PATH = join(directory, "terminals.json");
    terminalEnvironments.push(env);
    expect(runLauncher(["stop"], env)).toContain(
      "No managed INSΠRE instance is running.",
    );
    // CI builds the browser before its parallel unit suite. Remove only this
    // source-checkout stamp so this serial lifecycle test still proves that a
    // stale build is rebuilt once, without competing with all Vitest workers.
    // A synthetic old chunk also proves the supported build path preserves
    // the outgoing generation before Vite empties dist/assets.
    const legacyAsset = "ContextPane-launcher-old.js";
    await mkdir(join(root, "dist", "assets"), { recursive: true });
    await rm(join(root, "dist", ".inspire-current-assets.json"), {
      force: true,
    });
    await writeFile(join(root, "dist", "assets", legacyAsset), "old chunk\n");
    await rm(join(root, ".inspire-build"), { force: true });
    const output: Buffer[] = [];
    const child = spawn(process.execPath, [launcher, "restart"], {
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
    const cacheDirectory = defaultStaticAssetCacheDirectory(root, {
      environment: env,
      home,
    });
    const generations = JSON.parse(
      await readFile(join(cacheDirectory, "generations.json"), "utf8"),
    ) as { generations: { id: string }[] };
    const cachedCopies = await Promise.all(
      generations.generations.map((generation) =>
        readFile(
          join(cacheDirectory, "generations", generation.id, legacyAsset),
          "utf8",
        ).catch(() => null),
      ),
    );
    expect(cachedCopies).toContain("old chunk\n");
    const publishedLegacyAsset = join(root, "dist", "assets", legacyAsset);
    await expect(readFile(publishedLegacyAsset, "utf8")).resolves.toBe(
      "old chunk\n",
    );
    // Removing the handoff copy proves the running Host can still fall back to
    // its complete archived generation.
    await rm(publishedLegacyAsset);
    const origin = `http://127.0.0.1:${port}`;
    const retainedAssetResponse = await fetch(
      `${origin}/assets/${legacyAsset}`,
    );
    expect(retainedAssetResponse.status).toBe(200);
    expect(await retainedAssetResponse.text()).toBe("old chunk\n");
    const terminalHeaders = {
      Authorization: `Bearer ${firstState.token}`,
      "Content-Type": "application/json",
    };
    const createdTerminalResponse = await fetch(`${origin}/api/terminals`, {
      method: "POST",
      headers: terminalHeaders,
      body: JSON.stringify({ cwd: directory, cols: 80, rows: 24 }),
    });
    expect(createdTerminalResponse.ok).toBe(true);
    const createdTerminal = (await createdTerminalResponse.json()) as {
      id: string;
    };

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

    const restarted = spawn(process.execPath, [launcher, "start"], {
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
    const restoredCatalogResponse = await fetch(
      `${origin}/api/terminals?cwd=${encodeURIComponent(directory)}`,
      { headers: terminalHeaders },
    );
    expect(restoredCatalogResponse.ok).toBe(true);
    const restoredCatalog = (await restoredCatalogResponse.json()) as {
      terminals: Array<{ id: string; status: string }>;
    };
    expect(restoredCatalog.terminals).toContainEqual(
      expect.objectContaining({ id: createdTerminal.id, status: "running" }),
    );
    const closeTerminalResponse = await fetch(
      `${origin}/api/terminals/${encodeURIComponent(createdTerminal.id)}?force=1`,
      { method: "DELETE", headers: terminalHeaders },
    );
    expect(closeTerminalResponse.ok).toBe(true);
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
