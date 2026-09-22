import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  resolveLaunchEnvironment,
  systemdEnvironmentArguments,
} from "../../server/user-environment.mjs";

const directories = [];
const posix = process.platform !== "win32";
const bash = posix && existsSync("/bin/bash");
after(async () => {
  await Promise.all(
    directories.map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(rc = "") {
  const home = await mkdtemp(join(tmpdir(), "inspire user's environment-"));
  directories.push(home);
  await mkdir(join(home, ".local/bin"), { recursive: true });
  await writeFile(join(home, ".bash_profile"), '. "$HOME/.bashrc"\n');
  await writeFile(join(home, ".bashrc"), rc);
  return {
    home,
    environment: {
      HOME: home,
      SHELL: "/bin/bash",
      PATH: "/usr/bin:/bin",
      INSPIRE_ENVIRONMENT: "shell",
    },
  };
}

test("direct launches preserve caller environment without invoking a shell on any platform", async () => {
  const environment = {
    PATH: "/custom/bin",
    SHELL: "/missing/shell",
    NODE_ENV: "",
    CUSTOM: "value",
  };
  for (const platform of ["linux", "darwin", "win32"]) {
    const result = await resolveLaunchEnvironment(environment, { platform });
    assert.deepEqual(result, environment);
    assert.notEqual(result, environment);
  }
  assert.deepEqual(
    await resolveLaunchEnvironment(environment, { service: false }),
    environment,
  );
  assert.deepEqual(
    await resolveLaunchEnvironment(
      { ...environment, INSPIRE_ENVIRONMENT: "inherit" },
      { service: true },
    ),
    { ...environment, INSPIRE_ENVIRONMENT: "inherit" },
  );
});

test("invalid modes and unsupported shell discovery fail explicitly", async () => {
  await assert.rejects(
    resolveLaunchEnvironment({ INSPIRE_ENVIRONMENT: "typo" }),
    /must be inherit or shell/,
  );
  await assert.rejects(
    resolveLaunchEnvironment(
      { INSPIRE_ENVIRONMENT: "shell" },
      { platform: "win32" },
    ),
    /POSIX-only/,
  );
  if (posix) {
    await assert.rejects(
      resolveLaunchEnvironment({
        INSPIRE_ENVIRONMENT: "shell",
        SHELL: "/bin/nu",
      }),
      /supported absolute shell path/,
    );
    await assert.rejects(
      resolveLaunchEnvironment({ INSPIRE_ENVIRONMENT: "shell", SHELL: "bash" }),
      /supported absolute shell path/,
    );
  }
});

test("service discovery honors interactive login setup, unsets, and arbitrary exported values", {
  skip: !bash,
}, async () => {
  const f = await fixture(`
printf 'private startup banner\\n'
printf 'private startup warning\\n' >&2
export PATH="$HOME/.local/bin:/usr/bin:/bin"
export MULTILINE='line one
line two=你好'
export HTTPS_PROXY='http://example.invalid:1234'
export INSPIRE_PORT=9999
unset REMOVE_ME
printf 'initialized\\n' >> "$HOME/probes"
`);
  const tool = join(f.home, ".local/bin/user-tool");
  await writeFile(tool, "#!/bin/sh\nprintf user-tool-found\n");
  await chmod(tool, 0o755);
  const environment = {
    ...f.environment,
    REMOVE_ME: "remove this",
    INSPIRE_PORT: "4567",
    INVOCATION_ID: "service-identity",
    PWD: "/caller",
    SHLVL: "2",
  };
  delete environment.INSPIRE_ENVIRONMENT;
  const result = await resolveLaunchEnvironment(environment, { service: true });
  assert.equal(result.PATH, `${f.home}/.local/bin:/usr/bin:/bin`);
  assert.equal(result.MULTILINE, "line one\nline two=你好");
  assert.equal(result.HTTPS_PROXY, "http://example.invalid:1234");
  assert.equal(result.REMOVE_ME, undefined);
  assert.equal(result.NODE_ENV, undefined);
  assert.equal(result.INSPIRE_PORT, "4567");
  assert.equal(result.INVOCATION_ID, "service-identity");
  assert.equal(result.PWD, "/caller");
  assert.equal(result.SHLVL, "2");
  assert.equal(result.INSPIRE_RESOLVING_ENVIRONMENT, undefined);
  assert.equal(result.TERM, undefined);
  assert.equal(result.INSPIRE_ENVIRONMENT, "inherit");
  assert.equal(
    execFileSync("user-tool", [], { env: result, encoding: "utf8" }),
    "user-tool-found",
  );
  assert.deepEqual(
    await resolveLaunchEnvironment(result, { service: true }),
    result,
  );
  assert.equal(await readFile(join(f.home, "probes"), "utf8"), "initialized\n");
  assert.equal(environment.REMOVE_ME, "remove this");
});

test("discovery preserves a caller-supplied NODE_ENV, including the empty value", {
  skip: !bash,
}, async () => {
  const f = await fixture();
  for (const NODE_ENV of ["", "development", "production", "test"]) {
    const result = await resolveLaunchEnvironment({
      ...f.environment,
      NODE_ENV,
    });
    assert.equal(result.NODE_ENV, NODE_ENV);
  }
});

test("an explicit shell path takes precedence over SHELL", {
  skip: !bash,
}, async () => {
  const f = await fixture("export DISCOVERED=yes\n");
  const result = await resolveLaunchEnvironment({
    ...f.environment,
    SHELL: "/missing/shell",
    INSPIRE_SHELL: "/bin/bash",
  });
  assert.equal(result.DISCOVERED, "yes");
  assert.equal(result.SHELL, "/bin/bash");
});

test("startup failures and missing exports do not expose shell output or accept partial environment", {
  skip: !bash,
}, async () => {
  for (const rc of ["echo private-credential >&2; exit 17\n", "exit 0\n"]) {
    const f = await fixture(rc);
    await assert.rejects(resolveLaunchEnvironment(f.environment), (error) => {
      assert.match(error.message, /Unable to load the user shell environment/);
      assert.match(error.message, /INSPIRE_ENVIRONMENT=inherit/);
      assert.doesNotMatch(error.message, /private-credential/);
      return true;
    });
  }
  const f = await fixture();
  await assert.rejects(
    resolveLaunchEnvironment({
      ...f.environment,
      INSPIRE_SHELL: "/missing/bash",
    }),
    /could not be started/,
  );
});

test("startup has a deadline and terminates its isolated shell", {
  skip: !bash,
}, async () => {
  const f = await fixture('echo $$ > "$HOME/shell-pid"\nsleep 30\n');
  const started = Date.now();
  await assert.rejects(
    resolveLaunchEnvironment(f.environment, { timeoutMs: 400 }),
    /timed out/,
  );
  assert.ok(Date.now() - started < 5_000);
  const pid = Number(await readFile(join(f.home, "shell-pid"), "utf8"));
  for (let tries = 0; tries < 50; tries++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal(error.code, "ESRCH");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed-out shell remained alive");
});

test("export size is bounded independently of ignored startup output", {
  skip: !bash,
}, async () => {
  const f = await fixture("printf 'banner\\n'\n");
  await assert.rejects(
    resolveLaunchEnvironment(f.environment, { maxBytes: 32 }),
    /size limit/,
  );
});

test("transient services receive named exports without secrets or stale systemd identity in argv", () => {
  assert.deepEqual(
    systemdEnvironmentArguments({
      PATH: "/private/bin",
      TOKEN: "private credential",
      NODE_ENV: "",
      UNSET: undefined,
      INVOCATION_ID: "old-host",
      SYSTEMD_EXEC_PID: "123",
      NOTIFY_SOCKET: "/old/socket",
      "invalid-name": "bad",
      "bad\nkey": "bad",
    }),
    ["--setenv=PATH", "--setenv=TOKEN", "--setenv=NODE_ENV"],
  );
});
