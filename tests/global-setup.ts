import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

/** Isolate each project's Host sockets and Pi attach-control registry. */
export default async function setup(project: TestProject) {
  const runtime = await mkdtemp(join(tmpdir(), "inspire-test-run-"));
  project.config.env.XDG_RUNTIME_DIR = runtime;
  const userRuntime = process.env.XDG_RUNTIME_DIR;
  if (
    project.name === "herdr-scopes" &&
    process.platform === "linux" &&
    userRuntime
  ) {
    // Forward only systemd-run's user-manager socket into this project's runtime.
    await mkdir(join(runtime, "systemd"));
    await symlink(
      join(userRuntime, "systemd/private"),
      join(runtime, "systemd/private"),
    );
  }
  return () => rm(runtime, { recursive: true, force: true });
}
