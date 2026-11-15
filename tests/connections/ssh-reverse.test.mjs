import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSshReverseConfig,
  sshCommandArguments,
  sshFailureSummary,
} from "../../connections/ssh-reverse/runner.mjs";

import { preparePackagedLauncher } from "../fixtures/packaged-launcher.mjs";

const temporary = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ssh-reverse connection module", () => {
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

  it.runIf(process.platform === "linux")(
    "dispatches packaged and aliased connections and only replaces its own service",
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), "inspire-ssh-package-"));
      temporary.push(fixture);
      const root = join(fixture, "INSΠRE review");
      const alias = join(fixture, "package-link");
      const configHome = join(fixture, "config");
      const unitPath = join(
        configHome,
        "systemd",
        "user",
        "inspire-connection-ssh-reverse.service",
      );
      const bin = join(fixture, "bin");
      const log = join(fixture, "systemctl.log");
      const config = join(fixture, "direct.env");
      await Promise.all([
        mkdir(root),
        mkdir(bin),
        mkdir(join(configHome, "systemd", "user"), { recursive: true }),
      ]);
      await preparePackagedLauncher(root);
      await Promise.all([
        ...["connections", "deploy/systemd"].map((directory) =>
          cp(resolve(directory), join(root, directory), { recursive: true }),
        ),
        symlink(root, alias, "dir"),
        writeFile(
          join(bin, "systemctl"),
          '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\n',
          { mode: 0o700 },
        ),
      ]);
      const environment = {
        HOME: fixture,
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: join(fixture, "state"),
        XDG_RUNTIME_DIR: join(fixture, "runtime"),
        INSPIRE_SSH_REVERSE_CONFIG: config,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        SYSTEMCTL_LOG: log,
      };
      const dispatch = (
        action,
        path = root,
        overrides = {},
        name = "ssh-reverse",
      ) =>
        spawnSync(
          process.execPath,
          path === root
            ? [join(root, "inspire.mjs"), "connection", name, action]
            : [
                join(root, "connections", "dispatch.mjs"),
                "--root",
                path,
                name,
                action,
              ],
          {
            encoding: "utf8",
            timeout: 5_000,
            env: { ...environment, ...overrides },
          },
        );

      const invalid = dispatch("init", root, {}, "../ssh-reverse");
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain("Connection name is not valid");
      const aliasConfig = join(fixture, "alias.env");
      for (const [path, target] of [
        [root, config],
        [alias, aliasConfig],
      ]) {
        const result = dispatch("init", path, {
          INSPIRE_SSH_REVERSE_CONFIG: target,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(await readFile(target, "utf8")).toContain(
          "INSPIRE_SSH_REMOTE_PORT=14587",
        );
      }
      await writeFile(
        config,
        "INSPIRE_SSH_TARGET=example\nINSPIRE_SSH_REMOTE_PORT=14587\n",
      );
      const foreignUnit =
        "[Service]\nWorkingDirectory=/another/checkout\nExecStart=/another/runner\n";
      await writeFile(unitPath, foreignUnit);
      for (const action of ["start", "stop", "restart", "install-service"]) {
        const result = dispatch(action);
        expect(result.status, `${action}: ${result.stderr}`).not.toBe(0);
      }
      const status = dispatch("status");
      expect(status.status).not.toBe(0);
      expect(status.stdout).toContain("SSH reverse connection: not running.");
      expect(status.stderr).toContain("active for another installation");
      expect(await readFile(unitPath, "utf8")).toBe(foreignUnit);
      expect(await readFile(log, "utf8")).not.toMatch(
        /^--user (?:start|stop|restart|enable|disable|daemon-reload)\b/mu,
      );

      const workingDirectory = `WorkingDirectory=${join(fixture, "INS\\xce\\xa0RE\\x20review")}`;
      await writeFile(
        unitPath,
        `[Service]\n${workingDirectory}\nExecStart=/old/runner\n`,
      );
      const install = dispatch("install-service");
      expect(install.status, install.stderr).toBe(0);
      expect(await readFile(unitPath, "utf8")).toContain(workingDirectory);
      expect(await readFile(log, "utf8")).toMatch(
        /--user daemon-reload\n--user restart inspire-connection-ssh-reverse\.service\n$/u,
      );
    },
  );

  it("turns explicit configuration into a loopback-only SSH command", () => {
    const settings = [
      "INSPIRE_SSH_TARGET=relay@example.test",
      "INSPIRE_SSH_REMOTE_PORT=14587",
      "INSPIRE_SSH_LOCAL_PORT=4588",
    ].join("\n");
    const args = (extra = "") =>
      sshCommandArguments(parseSshReverseConfig(settings + extra));
    const ordinary = args();
    expect(ordinary).toEqual(
      expect.arrayContaining([
        "127.0.0.1:14587:127.0.0.1:4588",
        "ExitOnForwardFailure=yes",
        "ConnectTimeout=10",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=3",
      ]),
    );
    expect(ordinary.at(-1)).toBe("relay@example.test");
    const identity = "/home/demo/.ssh/tunnel";
    expect(args(`\nINSPIRE_SSH_IDENTITY_FILE=${identity}`)).toEqual(
      expect.arrayContaining([identity, "IdentitiesOnly=yes"]),
    );
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
});
