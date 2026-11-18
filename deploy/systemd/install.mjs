import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { hostServicePath, runSystemctl } from "./control.mjs";

export function unitWorkingDirectory(root) {
  if (/[\r\n]/u.test(root))
    throw new Error("The systemd working directory must fit on one line");
  // WorkingDirectory takes a literal path. Protect a trailing space or continuation.
  const path = /[\s\\]$/u.test(root) ? root + "/." : root;
  return "WorkingDirectory=" + path.replaceAll("%", "%%");
}

function unitWord(value) {
  return value.replaceAll("%", "%%").replace(/[^A-Za-z0-9_@%+=:,./-]/gu, (character) =>
    [...Buffer.from(character)]
      .map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`)
      .join(""),
  );
}

export function renderUnit(template, paths) {
  return template.replace(/^.*@[A-Z_]+@.*$/gm, (line) => {
    if (line === "WorkingDirectory=@ROOT@")
      return unitWorkingDirectory(paths.ROOT);
    const rendered = line.replace(/@([A-Z_]+)@/gu, (_, key) => unitWord(paths[key]));
    // A literal dollar in an Exec argument needs systemd's no-expansion prefix.
    return rendered.startsWith("Exec") && rendered.includes("\\x24")
      ? rendered.replace("=", "=:")
      : rendered;
  });
}

export async function writeUnit(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o644, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  const [flag, rootValue, action] = process.argv.slice(2);
  if (flag !== "--root" || !rootValue || action !== "install-host") {
    console.error("Use: ./inspire service install-host");
    process.exitCode = 64;
    return;
  }
  const root = resolve(rootValue);
  const unitDirectory = dirname(hostServicePath());
  const units = [
    "inspire-host.service",
    "inspire-terminal.service",
    "inspire-idle-maintenance-restart.service",
    "inspire-idle-maintenance-restart.timer",
  ];
  const paths = {
    ROOT: root,
    NODE_BIN: dirname(process.execPath),
    LAUNCHER: join(root, "inspire"),
  };
  await Promise.all(
    units.map(async (name) => {
      const template = await readFile(new URL(name + ".in", import.meta.url), "utf8");
      await writeUnit(join(unitDirectory, name), renderUnit(template, paths));
    }),
  );
  const reloaded = await runSystemctl(["--user", "daemon-reload"]);
  if (reloaded.code !== 0)
    throw new Error(
      `Installed user units, but systemd could not reload (${reloaded.stderr.trim()})`,
    );
  console.log(`Installed ${units.join(", ")} in ${unitDirectory}.`);
  console.log(
    "Enable the host with: ./inspire service enable-host. Scheduled maintenance requires separate opt-in.",
  );
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
