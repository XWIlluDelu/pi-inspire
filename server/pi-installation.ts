import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

interface PiPackageManifest {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
  exports?: unknown;
}

export interface PiInstallationIdentity {
  commandPath: string;
  packageRoot: string;
  cliPath: string;
  sdkEntryPath: string;
  version: string;
}

export interface PiInstallation extends PiInstallationIdentity {
  sdk: typeof import("@earendil-works/pi-coding-agent");
}

export interface PiInstallationOptions {
  command?: string;
  path?: string;
  installationRoot?: string;
}

function isInside(path: string, parent: string): boolean {
  const offset = relative(parent, path);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function executableCandidates(command: string, path: string): string[] {
  if (command.includes("/") || isAbsolute(command)) return [resolve(command)];
  return path
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => resolve(directory, command));
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findPackageRoot(entryPath: string): Promise<{
  root: string;
  manifest: PiPackageManifest;
} | null> {
  let directory = dirname(entryPath);
  while (true) {
    const manifestPath = join(directory, "package.json");
    try {
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as PiPackageManifest;
      if (manifest.name === PI_PACKAGE_NAME) {
        return { root: directory, manifest };
      }
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function packagePath(root: string, field: unknown, label: string): string {
  if (typeof field !== "string" || isAbsolute(field)) {
    throw new Error(`The installed Pi package does not expose its ${label}.`);
  }
  const path = resolve(root, field);
  if (!isInside(path, root)) {
    throw new Error(`The installed Pi package has an invalid ${label}.`);
  }
  return path;
}

function manifestPaths(
  root: string,
  manifest: PiPackageManifest,
): {
  cliPath: string;
  sdkEntryPath: string;
} {
  const bin = manifest.bin as Record<string, unknown> | undefined;
  const exportsField = manifest.exports as Record<string, unknown> | undefined;
  const rootExport = exportsField?.["."];
  const importEntry =
    typeof rootExport === "string"
      ? rootExport
      : (rootExport as Record<string, unknown> | undefined)?.import;
  return {
    cliPath: packagePath(root, bin?.pi, "pi CLI entry"),
    sdkEntryPath: packagePath(root, importEntry, "Pi SDK entry"),
  };
}

async function inspectCandidate(commandPath: string): Promise<{
  commandPath: string;
  packageRoot: string;
  manifest: PiPackageManifest;
  cliPath: string;
  sdkEntryPath: string;
} | null> {
  if (!(await isExecutable(commandPath))) return null;
  const resolvedCommand = await realpath(commandPath);
  const found = await findPackageRoot(resolvedCommand);
  if (!found) return null;
  const paths = manifestPaths(found.root, found.manifest);
  return {
    commandPath,
    packageRoot: found.root,
    manifest: found.manifest,
    ...paths,
  };
}

/** Resolve the external package identity without importing its SDK. Maintenance
 * uses this to compare an installed upgrade without loading it into the host
 * that is still serving the old runtime. */
export async function resolvePiInstallationIdentity(
  options: PiInstallationOptions = {},
): Promise<PiInstallationIdentity> {
  const explicitCommand = options.command ?? process.env.INSPIRE_PI_COMMAND;
  const command = explicitCommand || "pi";
  const searchPath = options.path ?? process.env.PATH ?? "";
  const installationRoot = resolve(
    options.installationRoot ??
      process.env.INSPIRE_INSTALLATION_ROOT ??
      process.cwd(),
  );
  let discoveredLocal: Awaited<ReturnType<typeof inspectCandidate>> = null;

  for (const candidate of executableCandidates(command, searchPath)) {
    const inspected = await inspectCandidate(candidate);
    if (!inspected) continue;
    if (!explicitCommand && isInside(inspected.packageRoot, installationRoot)) {
      discoveredLocal ??= inspected;
      continue;
    }
    const version = inspected.manifest.version;
    if (typeof version !== "string") {
      throw new Error(`The Pi package at ${candidate} has no version.`);
    }
    return {
      commandPath: candidate,
      packageRoot: inspected.packageRoot,
      cliPath: inspected.cliPath,
      sdkEntryPath: inspected.sdkEntryPath,
      version,
    };
  }

  if (discoveredLocal) {
    throw new Error(
      "INSΠRE requires a separately installed Pi runtime; the only Pi found belongs to this INSΠRE checkout. " +
        "Install or update Pi globally, then restart INSΠRE.",
    );
  }
  throw new Error(
    explicitCommand
      ? `INSPIRE_PI_COMMAND does not identify a ${PI_PACKAGE_NAME} installation: ${explicitCommand}`
      : "INSΠRE requires Pi to be installed and available on PATH. Install Pi globally, then restart INSΠRE.",
  );
}

export async function resolvePiInstallation(
  options: PiInstallationOptions = {},
): Promise<PiInstallation> {
  const identity = await resolvePiInstallationIdentity(options);
  const imported = await import(pathToFileURL(identity.sdkEntryPath).href);
  return {
    ...identity,
    sdk: imported as PiInstallation["sdk"],
  };
}

export const piInstallation = await resolvePiInstallation();
