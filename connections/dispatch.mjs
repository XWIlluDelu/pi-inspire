import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ID = /^[a-z][a-z0-9-]{0,63}$/;

function usage() {
  console.error(
    "Use: ./inspire connection <name> [start|stop|status|init|supervise|install-service]",
  );
}

function connectionRoot(root, id) {
  if (!MODULE_ID.test(id)) throw new Error("Connection name is not valid");
  const base = resolve(root, "connections");
  const path = resolve(base, id);
  if (!path.startsWith(`${base}${sep}`))
    throw new Error("Connection module escapes the connections directory");
  return path;
}

export async function loadConnectionManifest(root, id) {
  const directory = connectionRoot(root, id);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
  } catch {
    throw new Error(`Connection module \`${id}\` is not installed`);
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.id !== id ||
    typeof manifest.entry !== "string" ||
    !/^[-a-zA-Z0-9_.]+\.mjs$/.test(manifest.entry) ||
    !Array.isArray(manifest.actions) ||
    !manifest.actions.every((action) => typeof action === "string")
  ) {
    throw new Error(`Connection module \`${id}\` has an invalid manifest`);
  }
  const entry = resolve(directory, manifest.entry);
  if (dirname(entry) !== directory)
    throw new Error(`Connection module \`${id}\` has an invalid entry`);
  return { directory, manifest, entry };
}

async function listConnections(root) {
  const directory = resolve(root, "connections");
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !MODULE_ID.test(entry.name)) continue;
    try {
      await loadConnectionManifest(root, entry.name);
      ids.push(entry.name);
    } catch {
      // A partially installed module is not executable and is omitted from the
      // list rather than causing unrelated modules to disappear.
    }
  }
  if (ids.length === 0) {
    console.log("No connection modules are installed.");
    return;
  }
  for (const id of ids.sort()) console.log(id);
}

async function main() {
  const [rootFlag, rootValue, name, action = "start", ...rest] =
    process.argv.slice(2);
  if (rootFlag !== "--root" || !rootValue || !name) {
    usage();
    process.exitCode = 64;
    return;
  }
  const root = resolve(rootValue);
  if (name === "list") {
    if (action !== "start" || rest.length > 0) {
      usage();
      process.exitCode = 64;
      return;
    }
    await listConnections(root);
    return;
  }
  const module = await loadConnectionManifest(root, name);
  if (!module.manifest.actions.includes(action)) {
    throw new Error(
      `Connection module \`${name}\` does not support \`${action}\``,
    );
  }
  const child = spawn(
    process.execPath,
    [module.entry, "--root", root, action, ...rest],
    { stdio: "inherit", env: process.env },
  );
  const code = await new Promise((resolveChild, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) =>
      resolveChild(exitCode ?? (signal ? 1 : 0)),
    );
  });
  process.exitCode = code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
