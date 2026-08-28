import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSshReverseConfig,
  sshCommandArguments,
  sshFailureSummary,
  sshReverseServiceBelongsToRoot,
} from "../../connections/ssh-reverse/runner.mjs";

const temporary = [];

const runner = resolve("connections/ssh-reverse/runner.mjs");

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ssh-reverse connection module", () => {
  it("accepts a small explicit connection configuration", () => {
    expect(
      parseSshReverseConfig(
        [
          "INSPIRE_SSH_TARGET=relay@example.test",
          "INSPIRE_SSH_REMOTE_PORT=14587",
          "INSPIRE_SSH_LOCAL_PORT=4588",
          "INSPIRE_SSH_IDENTITY_FILE=/home/demo/.ssh/inspire-tunnel",
        ].join("\n"),
      ),
    ).toEqual({
      target: "relay@example.test",
      remotePort: 14587,
      localPort: 4588,
      identityFile: "/home/demo/.ssh/inspire-tunnel",
    });
  });

  it("rejects shell-like, duplicate, and unknown configuration", () => {
    expect(() =>
      parseSshReverseConfig(
        "INSPIRE_SSH_TARGET=-oProxyCommand=unsafe\nINSPIRE_SSH_REMOTE_PORT=14587\n",
      ),
    ).toThrow("INSPIRE_SSH_TARGET");
    expect(() =>
      parseSshReverseConfig(
        "INSPIRE_SSH_TARGET=relay\nINSPIRE_SSH_REMOTE_PORT=14587\nINSPIRE_SSH_REMOTE_PORT=14588\n",
      ),
    ).toThrow("INSPIRE_SSH_REMOTE_PORT");
    expect(() =>
      parseSshReverseConfig(
        "INSPIRE_SSH_TARGET=relay\nINSPIRE_SSH_REMOTE_PORT=14587\nUNSAFE=value\n",
      ),
    ).toThrow("UNSAFE");
  });

  it.runIf(process.platform !== "win32")(
    "does not let one checkout claim another checkout's user service",
    () => {
      const unit = [
        "[Service]",
        "WorkingDirectory=/srv/inspire-a",
        "ExecStart=/usr/bin/node /srv/inspire-a/runner.mjs --root /srv/inspire-a supervise",
        "",
      ].join("\n");

      expect(sshReverseServiceBelongsToRoot(unit, "/srv/inspire-a")).toBe(true);
      expect(sshReverseServiceBelongsToRoot(unit, "/srv/inspire-b")).toBe(
        false,
      );
      expect(
        sshReverseServiceBelongsToRoot(
          "[Service]\nWorkingDirectory=/srv/INS\\xce\\xa0RE\\x20review\n",
          "/srv/INSΠRE review",
        ),
      ).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "does not control an active user service owned by another checkout",
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), "inspire ssh service-"));
      temporary.push(fixture);
      const root = join(fixture, "current");
      const configHome = join(fixture, "config");
      const bin = join(fixture, "bin");
      const log = join(fixture, "systemctl.log");
      await Promise.all([
        mkdir(join(root, ".inspire", "connections"), { recursive: true }),
        mkdir(join(configHome, "systemd", "user"), { recursive: true }),
        mkdir(bin, { recursive: true }),
      ]);
      const config = join(root, ".inspire", "connections", "ssh-reverse.env");
      await writeFile(
        config,
        "INSPIRE_SSH_TARGET=example\nINSPIRE_SSH_REMOTE_PORT=14587\nINSPIRE_SSH_LOCAL_PORT=65534\n",
        { mode: 0o600 },
      );
      await writeFile(
        join(
          configHome,
          "systemd",
          "user",
          "inspire-connection-ssh-reverse.service",
        ),
        "[Service]\nWorkingDirectory=/another/checkout\nExecStart=/another/runner\n",
      );
      const systemctl = join(bin, "systemctl");
      await writeFile(
        systemctl,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "$SYSTEMCTL_LOG"\ncase "$*" in\n  *is-active*) exit 0 ;;\nesac\nexit 0\n`,
      );
      await chmod(systemctl, 0o700);
      const environment = {
        ...process.env,
        HOME: fixture,
        XDG_CONFIG_HOME: configHome,
        XDG_RUNTIME_DIR: join(fixture, "runtime"),
        INSPIRE_SSH_REVERSE_CONFIG: config,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        SYSTEMCTL_LOG: log,
      };

      for (const action of ["start", "stop", "restart", "install-service"]) {
        const result = spawnSync(
          process.execPath,
          [runner, "--root", root, action],
          {
            encoding: "utf8",
            env: environment,
          },
        );
        expect(result.status, `${action}: ${result.stderr}`).not.toBe(0);
      }
      const status = spawnSync(
        process.execPath,
        [runner, "--root", root, "status"],
        { encoding: "utf8", env: environment },
      );
      expect(status.status).not.toBe(0);
      expect(status.stdout, status.stderr).toContain(
        "SSH reverse connection: not running.",
      );
      expect(status.stderr).toContain("active for another installation");

      const calls = (await readFile(log, "utf8")).trim().split("\n");
      expect(calls).toHaveLength(5);
      expect(calls.every((call) => call.includes("is-active"))).toBe(true);
    },
  );

  it("always requests a loopback-only remote listener", () => {
    const arguments_ = sshCommandArguments(
      {
        target: "relay",
        remotePort: 14587,
        localPort: 4587,
        identityFile: undefined,
      },
      { controlPath: "/private/control", background: true },
    );
    expect(arguments_).toContain("127.0.0.1:14587:127.0.0.1:4587");
    expect(arguments_).toContain("ExitOnForwardFailure=yes");
    expect(arguments_).toContain("ConnectTimeout=10");
    expect(arguments_).toContain("ServerAliveInterval=15");
    expect(arguments_).toContain("ServerAliveCountMax=3");
    expect(arguments_).not.toContain("Compression=yes");
    expect(arguments_).not.toContain("IdentitiesOnly=yes");
  });

  it.each([
    ["Error: spawn ssh ENOENT", "client could not be started"],
    ["Permission denied (publickey)", "authentication was rejected"],
    ["Host key verification failed", "identity verification failed"],
    [
      "Error: remote port forwarding failed for listen port 14587",
      "configured reverse port",
    ],
    ["ssh: connect to host relay port 22: Connection timed out", "unreachable"],
    ["client_loop: send disconnect: Broken pipe", "connection was interrupted"],
  ])("classifies SSH failure layers: %s", (stderr, expected) => {
    expect(sshFailureSummary(stderr)).toContain(expected);
  });

  it("uses an explicit identity only when configured", () => {
    const arguments_ = sshCommandArguments({
      target: "relay",
      remotePort: 14587,
      localPort: 4587,
      identityFile: "/home/demo/.ssh/tunnel",
    });
    expect(arguments_).toContain("/home/demo/.ssh/tunnel");
    expect(arguments_).toContain("IdentitiesOnly=yes");
  });
});
