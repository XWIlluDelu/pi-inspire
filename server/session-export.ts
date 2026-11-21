import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CURRENT_SESSION_VERSION } from "./pi-runtime.js";
import { requestError } from "./request-error.js";

/** Export must never overwrite its canonical input, including symlink/hardlink aliases. */
export async function assertExportDestination(
  path: string,
  sessionPath: string | null,
): Promise<void> {
  if (!sessionPath) return;
  if (resolve(path) === resolve(sessionPath))
    throw requestError("Export cannot overwrite the source Pi session", 400);
  const [source, target] = await Promise.all([
    stat(sessionPath).catch(() => null),
    stat(path).catch(() => null),
  ]);
  if (
    source &&
    target &&
    source.dev === target.dev &&
    source.ino === target.ino
  )
    throw requestError("Export cannot overwrite the source Pi session", 400);
  const canonical = await realpath(path).catch(() => null);
  if (
    canonical &&
    canonical === (await realpath(sessionPath).catch(() => null))
  )
    throw requestError("Export cannot overwrite the source Pi session", 400);
}

/** Native serializeSessionBranch semantics without opening/switching a SessionManager. */
export async function writeBranchExport(
  path: string,
  session: { id: string; cwd: string; sessionPath: string | null },
  entries: readonly SessionEntry[],
): Promise<void> {
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: session.id,
    timestamp: new Date().toISOString(),
    cwd: session.cwd,
  };
  const content = `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await mkdir(dirname(path), { recursive: true });
  await assertExportDestination(path, session.sessionPath);
  await writeFile(path, content, { mode: 0o600 });
}
