import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import type { FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { requestError } from "./request-error.js";
import type {
  StagedSessionFork,
  StageSessionForkRequest,
} from "./session-fork.js";
import { SessionDocumentReader } from "./session-jsonl.js";

export type ForkWorkerInput = StageSessionForkRequest & {
  stagingDir: string;
  sdkEntryPath: string;
};

export type ForkWorkerReply =
  | Omit<StagedSessionFork, "destinationPath">
  | { error: string; status: number };

async function copy(request: ForkWorkerInput): Promise<ForkWorkerReply> {
  const { SessionManager, migrateSessionEntries } = (await import(
    pathToFileURL(request.sdkEntryPath).href
  )) as typeof import("@earendil-works/pi-coding-agent");
  const changed = () =>
    requestError(
      "The source Session changed before its fork boundary could be verified",
      409,
    );
  const document = await SessionDocumentReader.open(request.sourcePath).catch(
    () => {
      throw changed();
    },
  );
  try {
    const canonical = await realpath(request.sourcePath);
    const { sourceCommittedBytes, sourceIdentity } = request;
    const { dev, ino, size } = document.source;
    if (
      (sourceIdentity && sourceIdentity !== `${dev}:${ino}`) ||
      sourceCommittedBytes <= 0 ||
      BigInt(sourceCommittedBytes) > size
    )
      throw changed();
    const hash = createHash("sha256");
    const entries: FileEntry[] = [];
    const scan = await document
      .scan(
        0,
        (entry) => {
          entries.push(entry as unknown as FileEntry);
        },
        (frame) => hash.update(frame),
        undefined,
        sourceCommittedBytes,
      )
      .catch(() => {
        throw changed();
      });
    if (
      scan.completeBytes !== sourceCommittedBytes ||
      hash.digest("hex") !== request.sourceFingerprint ||
      scan.header?.id !== request.sourceSessionId
    )
      throw changed();
    migrateSessionEntries(entries);
    let destination: ReturnType<typeof SessionManager.inMemory>;
    if (request.mode === "recover") {
      // Seed Pi with the full attested tree and let it create the new header.
      destination = SessionManager.inMemory(
        request.destinationCwd,
        undefined,
        entries.slice(1) as SessionEntry[],
      );
    } else {
      const source = SessionManager.inMemory(
        scan.header.cwd,
        undefined,
        entries,
      );
      const target =
        request.targetId === null ? null : source.getEntry(request.targetId);
      if (
        (request.targetId !== null &&
          (!target || target.parentId !== request.targetParentId)) ||
        (request.mode !== "clone" &&
          (target?.type !== "message" || target.message.role !== "user"))
      )
        throw requestError(
          "The selected fork point is no longer available",
          409,
        );
      const endpoint =
        request.mode === "clone" ? request.targetId : request.targetParentId;
      destination =
        endpoint === null ? SessionManager.inMemory(source.getCwd()) : source;
      if (endpoint !== null) destination.createBranchedSession(endpoint);
    }
    const header = destination.getHeader();
    if (!header) throw new Error("Pi did not supply a branch header");
    const stagedPath = join(
      request.stagingDir,
      `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`,
    );
    const output = await open(stagedPath, "wx", 0o600);
    try {
      function* lines() {
        yield JSON.stringify({ ...header, parentSession: request.sourcePath }) +
          "\n";
        for (const entry of destination.getEntries())
          yield JSON.stringify(entry) + "\n";
      }
      await output.writeFile(lines());
    } finally {
      await output.close();
    }
    if (!(await document.stillAddressesPrefix(canonical))) throw changed();
    return {
      stagedPath,
      stagingDir: request.stagingDir,
      destinationId: header.id,
      sessionName: destination.getSessionName(),
      destinationLeafId: destination.getLeafId(),
    };
  } finally {
    await document.close();
  }
}

try {
  parentPort!.postMessage(await copy(workerData as ForkWorkerInput));
} catch (error) {
  parentPort!.postMessage({
    error: error instanceof Error ? error.message : "Session fork failed",
    status: (error as { status?: number } | null)?.status ?? 500,
  } satisfies ForkWorkerReply);
}
