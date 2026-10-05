import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CURRENT_SESSION_VERSION } from "./pi-runtime.js";
import { requestError } from "./request-error.js";

export function resolveExportPath(path: string, cwd: string): string {
  return resolve(
    cwd,
    path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? resolve(homedir(), path.slice(2))
        : path,
  );
}

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
export function serializeBranchExport(
  sessionId: string,
  cwd: string,
  value: unknown,
): string {
  const snapshot = value as {
    entries?: SessionEntry[];
    leafId?: string | null;
  } | null;
  if (
    !snapshot ||
    !Array.isArray(snapshot.entries) ||
    !(snapshot.leafId === null || typeof snapshot.leafId === "string")
  )
    throw new Error("Pi did not report the session branch to export");
  const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  const visited = new Set<string>();
  let id = snapshot.leafId;
  while (id !== null) {
    const entry = byId.get(id);
    if (!entry || visited.has(id))
      throw new Error("Pi reported an incomplete session branch");
    visited.add(id);
    branch.push(entry);
    id = entry.parentId;
  }
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd,
  };
  let parentId: string | null = null;
  const entries = branch.reverse().map((entry) => {
    const exported = { ...entry, parentId };
    parentId = entry.id;
    return exported;
  });
  return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export async function writeBranchExport(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: 0o600 });
}
