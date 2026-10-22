import { parentPort, workerData } from "node:worker_threads";
import type { SessionCatalogIssue } from "../shared/contracts.js";
import {
  SessionMetadataIndex,
  type SessionRecord,
} from "./session-metadata.js";

const { sessions, query, nativeSearchPath, partial } = workerData as {
  sessions: SessionRecord[];
  query: string;
  nativeSearchPath: string;
  partial: boolean;
};
const issues: SessionCatalogIssue[] = [];
const matches = await new SessionMetadataIndex().scanSearch(
  sessions,
  query,
  nativeSearchPath,
  partial ? issues : undefined,
);
parentPort!.postMessage({ ids: matches.map((session) => session.id), issues });
