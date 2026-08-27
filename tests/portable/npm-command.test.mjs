import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { npmInvocation } from "../../server/npm-command.mjs";

const directories = [];
after(async () => {
  await Promise.all(
    directories.map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fakeNodeInstallation() {
  const root = await mkdtemp(join(tmpdir(), "inspire-npm-command-"));
  directories.push(root);
  const executable = join(root, "node.exe");
  const npmCli = join(root, "node_modules", "npm", "bin", "npm-cli.js");
  await mkdir(dirname(npmCli), { recursive: true });
  await Promise.all([writeFile(executable, ""), writeFile(npmCli, "")]);
  return { executable, npmCli };
}

test("runs npm-cli.js directly for a normal Windows Node installation", async () => {
  const { executable, npmCli } = await fakeNodeInstallation();
  const invocation = npmInvocation(["run", "build"], {
    platform: "win32",
    executable,
    environment: {},
  });

  assert.equal(invocation.command, executable);
  assert.deepEqual(invocation.args, [npmCli, "run", "build"]);
  assert.deepEqual(invocation.environment, {});
});

test("keeps Windows fallback arguments out of PowerShell source text", () => {
  const hostile = "C:\\project & echo injected";
  const invocation = npmInvocation(["install", hostile], {
    platform: "win32",
    executable: "C:\\missing\\node.exe",
    environment: { SystemRoot: "C:\\Windows" },
  });
  const script = invocation.args.at(-1);

  assert.match(invocation.command, /powershell\.exe$/iu);
  assert.equal(typeof script, "string");
  assert.doesNotMatch(script, /echo injected/u);
  assert.deepEqual(
    JSON.parse(invocation.environment.INSPIRE_NPM_ARGUMENTS_JSON),
    ["install", hostile],
  );
});
