import { parentPort, workerData } from "node:worker_threads";
import {
  SessionMetadataIndex,
  type SessionRecord,
} from "./session-metadata.js";

const { sessions, query, nativeSearchPath } = workerData as {
  sessions: SessionRecord[];
  query: string;
  nativeSearchPath: string;
};
const matches = await new SessionMetadataIndex().scanSearch(
  sessions,
  query,
  nativeSearchPath,
);
parentPort!.postMessage(matches.map((session) => session.id));
