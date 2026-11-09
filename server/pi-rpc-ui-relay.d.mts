import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Native RPC dialogs retained by a worker's surviving launcher; null when
 * the channel cannot be created (Pi still runs without dialog recovery). */
export function createPiRpcUiRelay(): Promise<{
  environment: string;
  observeInput(chunk: Buffer): void;
  attach(child: ChildProcessWithoutNullStreams): void;
  close(): Promise<void>;
} | null>;
