import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Real Pi workers started by tests publish attach-control records and
 * sockets under XDG_RUNTIME_DIR. Give the run its own directory so they never
 * reach a running Inspire Host or the user's terminal Pi registry. */
export default async function setup(): Promise<() => Promise<void>> {
  const runtime = await mkdtemp(join(tmpdir(), "inspire-test-run-"));
  process.env.XDG_RUNTIME_DIR = runtime;
  return () => rm(runtime, { recursive: true, force: true });
}
