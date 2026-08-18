import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function systemdEscape(value) {
  return value.replace(/[^A-Za-z0-9_@%+=:,./-]/gu, (character) =>
    `\\x${character.codePointAt(0).toString(16).padStart(2, "0")}`,
  );
}

async function writeUnit(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function run(command, arguments_) {
  return new Promise((resolveRun) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", (error) => resolveRun({ code: 1, stderr: error.message }));
    child.once("exit", (code) => resolveRun({ code: code ?? 1, stderr }));
  });
}

function usage() {
  console.error("Use: ./inspire service install-host");
}

async function main() {
  const [flag, rootValue, action] = process.argv.slice(2);
  if (flag !== "--root" || !rootValue || action !== "install-host") {
    usage();
    process.exitCode = 64;
    return;
  }
  const root = resolve(rootValue);
  const template = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "inspire-host.service.in"),
    "utf8",
  );
  const content = template
    .replaceAll("@ROOT@", systemdEscape(root))
    .replaceAll("@NODE_BIN@", systemdEscape(dirname(process.execPath)))
    .replaceAll("@LAUNCHER@", systemdEscape(join(root, "inspire")));
  const configHome = process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), ".config");
  const path = join(configHome, "systemd", "user", "inspire-host.service");
  await writeUnit(path, content);
  const reloaded = await run("systemctl", ["--user", "daemon-reload"]);
  if (reloaded.code !== 0)
    throw new Error(`Installed ${path}, but systemd could not reload (${reloaded.stderr.trim()})`);
  console.log(`Installed ${path}.`);
  console.log("Enable it with: ./inspire service enable-host");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
