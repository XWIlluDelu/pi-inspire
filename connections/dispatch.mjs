import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const MODULE_ID = /^[a-z][a-z0-9-]{0,63}$/;

async function loadConnectionManifest(root, id) {
  if (!MODULE_ID.test(id)) throw new Error("Connection name is not valid");
  const directory = join(root, "connections", id);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(`Connection module \`${id}\` is not installed`);
    if (error instanceof SyntaxError)
      throw new Error(`Connection module \`${id}\` has an invalid manifest`);
    throw error;
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.id !== id ||
    typeof manifest.entry !== "string" ||
    !/^[-a-zA-Z0-9_.]+\.mjs$/.test(manifest.entry) ||
    !Array.isArray(manifest.actions) ||
    !manifest.actions.every((action) => typeof action === "string") ||
    (manifest.platforms !== undefined &&
      (!Array.isArray(manifest.platforms) ||
        !manifest.platforms.every((platform) =>
          ["linux", "darwin", "win32"].includes(platform),
        )))
  ) {
    throw new Error(`Connection module \`${id}\` has an invalid manifest`);
  }
  return { manifest, entry: join(directory, manifest.entry) };
}

async function listConnections(root) {
  const directory = join(root, "connections");
  const entries = await readdir(directory, { withFileTypes: true });
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await loadConnectionManifest(root, entry.name);
      ids.push(entry.name);
    } catch {
      // A partially installed module is not executable and is omitted from the
      // list rather than causing unrelated modules to disappear.
    }
  }
  console.log(ids.sort().join("\n") || "No connection modules are installed.");
}

/** The launcher starts the chosen runner with the same installation root. */
export async function dispatchConnection(root, [name, action, ...rest], runEntry) {
  if (!name || (name === "list" && action !== undefined)) {
    console.error("Use: inspire connection list | inspire connection <name> [action]");
    return 64;
  }
  if (name === "list") {
    await listConnections(root);
    return 0;
  }
  action ??= "start";
  const { manifest, entry } = await loadConnectionManifest(root, name);
  if (manifest.platforms && !manifest.platforms.includes(process.platform)) {
    throw new Error(
      `Connection module \`${name}\` supports ${manifest.platforms.join(", ")}, not ${process.platform}`,
    );
  }
  if (!manifest.actions.includes(action)) {
    throw new Error(
      `Connection module \`${name}\` does not support \`${action}\``,
    );
  }
  return runEntry(entry, [action, ...rest]);
}
