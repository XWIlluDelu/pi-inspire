import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ActiveSnapshot } from "../shared/contracts.js";
import type { SessionRecord } from "./session-catalog.js";

export type ActiveSessionSnapshot = NonNullable<ActiveSnapshot["active"]>;

/** Read the active Pi branch without constructing a runtime or writing the session file. */
export async function loadSessionPreview(session: SessionRecord): Promise<ActiveSessionSnapshot> {
  const fileEntries = parseSessionEntries(await readFile(session.path, "utf8"));
  const header = fileEntries[0];
  if (!header || header.type !== "session") {
    throw Object.assign(new Error("Session file is not a valid Pi session"), { status: 422 });
  }

  // Pi's migration is applied only to the in-memory entries. SessionManager.open()
  // is deliberately not used because it may rewrite legacy files during load.
  migrateSessionEntries(fileEntries);
  const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
  const context = buildSessionContext(entries);

  return {
    sessionId: session.id,
    sessionFile: resolve(session.path),
    sessionName: session.name,
    cwd: resolve(session.cwd || process.cwd()),
    model: context.model ? { provider: context.model.provider, id: context.model.modelId } : null,
    thinkingLevel: context.thinkingLevel,
    isStreaming: false,
    isCompacting: false,
    messages: context.messages,
    availableModels: [],
    commands: [],
  };
}
