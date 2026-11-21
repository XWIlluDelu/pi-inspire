import { realpath } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { stripImageDimensionNotes } from "../shared/image-dimension-notes.js";
import { jsonRecord } from "../shared/json-record.js";
import {
  preservesSessionPrefix,
  SessionDocumentReader,
} from "./session-jsonl.js";
import type { SessionRecord } from "./session-metadata.js";
import type { SessionSearchResult } from "./session-search.js";
import { compileSessionSearch } from "./session-search-query.js";

function searchMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const imageCount = content.filter(
    (value) => jsonRecord(value)?.type === "image",
  ).length;
  return content
    .flatMap((value) => {
      const block = jsonRecord(value);
      return block?.type === "text" && typeof block.text === "string"
        ? [stripImageDimensionNotes(block.text, imageCount)]
        : [];
    })
    .join(" ");
}

const { sessions, query } = workerData as {
  sessions: SessionRecord[];
  query: string;
};
const search = compileSessionSearch(query);
const hits = new Map<string, string | undefined>();
let complete = true;

if (search) {
  for (const session of sessions) {
    let document: SessionDocumentReader | undefined;
    try {
      const { source } = session;
      document = await SessionDocumentReader.open(session.path);
      const canonical = await realpath(session.path);
      if (
        !source ||
        !preservesSessionPrefix(document.source, source) ||
        !(await document.stillAddressesPrefix(canonical))
      ) {
        complete = false;
        continue;
      }
      let name: string | undefined;
      const messages: string[] = [];
      const limit = Number(source.size);
      const scan = await document.scan(
        0,
        (entry) => {
          if (entry.type === "session_info")
            name =
              typeof entry.name === "string"
                ? entry.name.trim() || undefined
                : undefined;
          if (entry.type !== "message") return;
          const message = jsonRecord(entry.message);
          if (message?.role !== "user" && message?.role !== "assistant") return;
          const text = searchMessageText(message);
          if (text) messages.push(text);
        },
        undefined,
        undefined,
        limit,
      );
      if (
        scan.end !== limit ||
        scan.header?.id !== session.id ||
        scan.header.cwd !== session.cwd ||
        !(await document.stillAddressesPrefix(canonical))
      ) {
        complete = false;
        continue;
      }
      const allMessagesText = messages.join(" ");
      if (
        search.matches({
          id: session.id,
          cwd: session.cwd,
          name,
          allMessagesText,
        })
      ) {
        hits.set(session.id, search.snippet(allMessagesText));
      }
    } catch {
      complete = false;
    } finally {
      await document?.close();
    }
  }
}
parentPort!.postMessage({ hits, complete } satisfies SessionSearchResult);
