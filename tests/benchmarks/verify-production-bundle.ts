import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const FORBIDDEN_PRODUCTION_SYMBOLS = [
  "BenchmarkSurface",
  "recordBenchmarkCommit",
  "__INSPIRE_MAINTENANCE_BENCHMARK__",
  "MAINTENANCE_BENCHMARK",
  "maintenance-benchmark",
  "benchmark-profiler",
] as const;

async function filesBelow(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if ((await stat(path)).isDirectory())
      result.push(...(await filesBelow(path)));
    else result.push(path);
  }
  return result;
}

const distFiles = await filesBelow("dist");
const searchable = distFiles.filter((path) =>
  /\.(?:html|js|css|map)$/u.test(path),
);
if (searchable.length === 0)
  throw new Error("Production bundle is absent; run npm run build first");

const leaks: string[] = [];
for (const path of searchable) {
  const content = await readFile(path, "utf8");
  for (const symbol of FORBIDDEN_PRODUCTION_SYMBOLS) {
    if (content.includes(symbol)) leaks.push(`${path}: ${symbol}`);
  }
}
if (leaks.length > 0)
  throw new Error(
    `Benchmark instrumentation leaked into production:\n${leaks.join("\n")}`,
  );

const appSource = await readFile("src/App.tsx", "utf8");
if (appSource.includes("BenchmarkSurface") || appSource.includes("<Fragment")) {
  throw new Error("App still uses a component or Fragment benchmark wrapper");
}
for (const content of [
  "navigationContent",
  "transcriptContent",
  "composerContent",
  "resourcesContent",
]) {
  if (!appSource.includes(`) : ${content}`))
    throw new Error(
      `Production direct-element fallback is missing for ${content}`,
    );
}

console.log(
  JSON.stringify(
    {
      productionFilesScanned: searchable.length,
      sourceMapsScanned: searchable.filter((path) => path.endsWith(".map"))
        .length,
      forbiddenSymbols: FORBIDDEN_PRODUCTION_SYMBOLS,
      benchmarkSymbolsFound: 0,
      productionFallbacks: [
        "navigation",
        "transcript",
        "composer",
        "resources",
      ],
      wrapperFibersInProductionBranches: 0,
    },
    null,
    2,
  ),
);
