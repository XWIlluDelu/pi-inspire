// Run manually: node --import tsx scripts/benchmark-projection-reads.mjs
// Measures reconciliation only, not Pi startup, page rendering, or network I/O.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionProjection } from "../server/session-projection.ts";

const directory = await mkdtemp(join(tmpdir(), "inspire-projection-bench-"));
const path = join(directory, "session.jsonl");
const timestamp = "2026-08-01T00:00:00.000Z";
const entries = [
  { type: "session", version: 3, id: "benchmark", cwd: directory, timestamp },
  ...Array.from({ length: 128 }, (_, index) => ({
    type: "message",
    id: `u${index}`,
    parentId: index ? `u${index - 1}` : null,
    timestamp,
    message: {
      role: "user",
      content: "x".repeat(128 * 1024),
      timestamp: index,
    },
  })),
];
const bytes = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
let projection;
try {
  await writeFile(path, bytes);
  projection = await SessionProjection.open({
    id: "benchmark",
    path,
    cwd: directory,
    source: null,
    created: new Date(timestamp),
    modified: new Date(timestamp),
    messageCount: 128,
    firstMessage: "benchmark",
    searchText: "benchmark",
  });
  await projection.suspendReconciliation();
  const samples = { forced: [], versionChecked: [] };
  for (let index = 0; index < 12; index += 1) {
    for (const force of [true, false]) {
      const start = performance.now();
      const result = await projection.reconcileSuspended(force);
      const elapsed = performance.now() - start;
      if (result.changed || result.health.status !== "ok")
        throw new Error("Benchmark source unexpectedly changed");
      if (index >= 3)
        samples[force ? "forced" : "versionChecked"].push(elapsed);
    }
  }
  const median = (values) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.log(
    JSON.stringify(
      {
        sourceBytes: Buffer.byteLength(bytes),
        samplesPerMode: samples.forced.length,
        medianMs: Object.fromEntries(
          Object.entries(samples).map(([name, values]) => [
            name,
            Number(median(values).toFixed(3)),
          ]),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await projection?.close();
  await rm(directory, { recursive: true, force: true });
}
