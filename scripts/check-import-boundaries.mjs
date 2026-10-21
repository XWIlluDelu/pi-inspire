import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cts",
  ".mts",
  ".cjs",
]);
const SOURCE_ROOTS = ["shared", "server", "src"];

/**
 * Keep the architecture directional without inventing a second ownership
 * mechanism. The shared protocol layer never learns product/runtime details;
 * server code never depends on browser code; browser controllers remain below
 * components so a controller can be tested without mounting UI.
 */
const boundaries = [
  { from: "shared/", forbid: ["src/", "server/"] },
  { from: "server/", forbid: ["src/"] },
  { from: "src/controllers/", forbid: ["src/components/"] },
  {
    from: "src/resource-preview.ts",
    forbid: ["src/components/", "src/store.ts"],
  },
];

function pathFrom(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

async function filesUnder(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function compilerOptions(root, filename) {
  const configPath = join(root, filename);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(
      `${filename}: ${ts.flattenDiagnosticMessageText(config.error.messageText, "\n")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      `${filename}: ${parsed.errors
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, "\n"),
        )
        .join("\n")}`,
    );
  }
  return parsed.options;
}

function resolveProjectModule(root, importer, specifier, options) {
  if (!specifier.startsWith(".")) return null;
  const resolved = ts.resolveModuleName(
    specifier,
    importer,
    options,
    ts.sys,
  ).resolvedModule;
  if (!resolved) return null;
  const path = resolve(resolved.resolvedFileName);
  const projectPath = pathFrom(root, path);
  if (
    projectPath === "" ||
    projectPath === ".." ||
    projectPath.startsWith("../") ||
    !SOURCE_EXTENSIONS.has(extname(path))
  )
    return null;
  return projectPath;
}

/** Resolve imports through the same TypeScript module rules used by the
 * compiler. In particular, NodeNext source deliberately spells local imports
 * as `.js`; TypeScript correctly resolves those specifiers to their `.ts`
 * source files before this checker applies architecture direction. */
export async function findImportBoundaryViolations(projectRoot = defaultRoot) {
  const root = resolve(projectRoot);
  const serverOptions = compilerOptions(root, "tsconfig.server.json");
  const webOptions = compilerOptions(root, "tsconfig.web.json");
  const files = (
    await Promise.all(
      SOURCE_ROOTS.map((directory) => filesUnder(resolve(root, directory))),
    )
  )
    .flat()
    .sort();
  const violations = [];

  for (const file of files) {
    const importer = pathFrom(root, file);
    const boundary = boundaries.find(
      ({ from }) => importer.startsWith(from) || importer === from,
    );
    if (!boundary) continue;
    const options = importer.startsWith("src/") ? webOptions : serverOptions;
    const source = await readFile(file, "utf8");
    const { importedFiles } = ts.preProcessFile(source, true, true);
    for (const { fileName } of importedFiles) {
      const imported = resolveProjectModule(root, file, fileName, options);
      if (
        !imported ||
        !boundary.forbid.some(
          (prefix) =>
            imported.startsWith(prefix) || imported === prefix.slice(0, -1),
        )
      )
        continue;
      violations.push(`${importer} must not import ${imported}`);
    }
  }

  return violations;
}

async function assertImportBoundaries(projectRoot = defaultRoot) {
  const violations = await findImportBoundaryViolations(projectRoot);
  if (violations.length > 0) {
    throw new Error(
      `Import-boundary violations:\n${violations.map((violation) => `- ${violation}`).join("\n")}`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await assertImportBoundaries();
