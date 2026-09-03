export const MAX_TERMINALS_PER_PROJECT = 32;
export const MAX_TERMINALS_TOTAL = 128;
export const MIN_TERMINAL_HISTORY_DAYS = 1;
export const MAX_TERMINAL_HISTORY_DAYS = 365;
export const MAX_TERMINAL_TITLE_CHARS = 120;
export const MAX_TERMINAL_COMMAND_CHARS = 16_384;
export const MAX_TERMINAL_CWD_CHARS = 4_096;
export const MAX_TERMINAL_PROFILE_ID_CHARS = 80;
export const MAX_TERMINAL_INPUT_BYTES = 256 * 1024;
export const MAX_TERMINAL_SOCKET_MESSAGE_BYTES = 512 * 1024;
export const MIN_TERMINAL_COLS = 2;
export const MAX_TERMINAL_COLS = 500;
export const MIN_TERMINAL_ROWS = 2;
export const MAX_TERMINAL_ROWS = 300;
export const INSPIRE_SHELL_OSC = 6973;

const TERMINAL_INPUT_FRAME = 1;
const TERMINAL_OUTPUT_FRAME = 2;
const TERMINAL_SNAPSHOT_FRAME = 3;
const TERMINAL_SNAPSHOT_CONTINUATION_FRAME = 4;
const TERMINAL_INPUT_HEADER_BYTES = 5;
const TERMINAL_SERVER_HEADER_BYTES = 13;

export type TerminalStatus = "running" | "exited";
export type TerminalTitleSource = "automatic" | "user";

export interface TerminalProfile {
  id: string;
  label: string;
  available: boolean;
  isDefault: boolean;
}

export interface TerminalDescriptor {
  /** Identity and revision of the daemon catalog that produced this value. */
  catalogEpoch: string;
  catalogRevision: number;
  id: string;
  projectCwd: string;
  title: string;
  titleSource: TerminalTitleSource;
  profileId: string;
  shellLabel: string;
  currentCwd: string;
  currentCommand: string;
  commandRunning: boolean;
  status: TerminalStatus;
  exitCode: number | null;
  signal: number | null;
  cols: number;
  rows: number;
  resizeRevision: number;
  outputEpoch: string;
  firstOutputOffset: number;
  nextOutputOffset: number;
  viewerCount: number;
  hasOwner: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalCatalogResponse {
  catalogEpoch: string;
  revision: number;
  terminals: TerminalDescriptor[];
  profiles: TerminalProfile[];
}

export interface TerminalServiceSettings {
  persistOutput: boolean;
  historyRetentionDays: number;
}

export interface TerminalServiceSettingsPatch {
  persistOutput?: boolean;
  historyRetentionDays?: number;
}

export interface TerminalCreateRequest {
  cwd: string;
  profileId?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalRenameRequest {
  title: string | null;
}

export interface TerminalRemoveResponse {
  catalogEpoch: string;
  revision: number;
}

export interface TerminalReorderRequest {
  cwd: string;
  terminalIds: string[];
}

export interface TerminalAttachTicketResponse {
  ticket: string;
  expiresAt: string;
}

export interface TerminalAttachRequest {
  type: "attach";
  ticket: string;
  clientId: string;
  cols: number;
  rows: number;
  outputEpoch?: string;
  nextOutputOffset?: number;
  resizeRevision?: number;
  ownerToken?: string;
}

export type TerminalClientControlMessage =
  | TerminalAttachRequest
  | { type: "resize"; cols: number; rows: number }
  | { type: "take_control"; cols: number; rows: number }
  | { type: "release_control" }
  | { type: "ping" };

export type TerminalServerControlMessage =
  | {
      type: "attached";
      terminal: TerminalDescriptor;
      attachmentId: string;
      writable: boolean;
      ownerToken?: string;
      nextInputSequence: number;
      replay: "delta" | "snapshot";
    }
  | { type: "replay_complete"; nextOutputOffset: number }
  | { type: "input_ack"; sequence: number }
  | {
      type: "ownership";
      writable: boolean;
      hasOwner: boolean;
      ownerToken?: string;
      nextInputSequence?: number;
      reason: "available" | "claimed" | "released" | "taken" | "reconnected";
    }
  | {
      type: "resized";
      cols: number;
      rows: number;
      resizeRevision: number;
    }
  | { type: "descriptor"; terminal: TerminalDescriptor }
  | {
      type: "command_complete";
      command: string;
      currentCwd: string;
      exitCode: number | null;
      durationMs: number | null;
    }
  | {
      type: "exit";
      exitCode: number;
      signal: number | null;
      terminal: TerminalDescriptor;
    }
  | { type: "heartbeat" }
  | { type: "error"; code: string; message: string; fatal: boolean };

interface TerminalInputFrame {
  sequence: number;
  data: Uint8Array;
}

export interface TerminalServerDataFrame {
  kind: "output" | "snapshot" | "snapshot-continuation";
  resizeRevision: number;
  offset: number;
  data: Uint8Array;
}

function bytesOf(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function checkedSequence(sequence: number): number {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 0xffffffff)
    throw new Error("Terminal input sequence is invalid");
  return sequence;
}

function checkedOffset(offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Terminal output offset is invalid");
  return offset;
}

export function encodeTerminalInputFrame(
  sequence: number,
  data: Uint8Array,
): Uint8Array {
  checkedSequence(sequence);
  if (data.byteLength < 1 || data.byteLength > MAX_TERMINAL_INPUT_BYTES)
    throw new Error("Terminal input frame has an invalid size");
  const frame = new Uint8Array(TERMINAL_INPUT_HEADER_BYTES + data.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, TERMINAL_INPUT_FRAME);
  view.setUint32(1, sequence);
  frame.set(data, TERMINAL_INPUT_HEADER_BYTES);
  return frame;
}

export function decodeTerminalInputFrame(
  value: ArrayBuffer | Uint8Array,
): TerminalInputFrame {
  const bytes = bytesOf(value);
  if (
    bytes.byteLength <= TERMINAL_INPUT_HEADER_BYTES ||
    bytes.byteLength > TERMINAL_INPUT_HEADER_BYTES + MAX_TERMINAL_INPUT_BYTES
  )
    throw new Error("Terminal input frame has an invalid size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== TERMINAL_INPUT_FRAME)
    throw new Error("Terminal input frame type is invalid");
  return {
    sequence: checkedSequence(view.getUint32(1)),
    data: bytes.slice(TERMINAL_INPUT_HEADER_BYTES),
  };
}

export function encodeTerminalServerDataFrame(
  kind: TerminalServerDataFrame["kind"],
  resizeRevision: number,
  offset: number,
  data: Uint8Array,
): Uint8Array {
  if (!Number.isSafeInteger(resizeRevision) || resizeRevision < 0)
    throw new Error("Terminal resize revision is invalid");
  checkedOffset(offset);
  const frame = new Uint8Array(TERMINAL_SERVER_HEADER_BYTES + data.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(
    0,
    kind === "snapshot"
      ? TERMINAL_SNAPSHOT_FRAME
      : kind === "snapshot-continuation"
        ? TERMINAL_SNAPSHOT_CONTINUATION_FRAME
        : TERMINAL_OUTPUT_FRAME,
  );
  view.setUint32(1, resizeRevision);
  view.setBigUint64(5, BigInt(offset));
  frame.set(data, TERMINAL_SERVER_HEADER_BYTES);
  return frame;
}

export function decodeTerminalServerDataFrame(
  value: ArrayBuffer | Uint8Array,
): TerminalServerDataFrame {
  const bytes = bytesOf(value);
  if (bytes.byteLength < TERMINAL_SERVER_HEADER_BYTES)
    throw new Error("Terminal server frame is too small");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);
  if (
    type !== TERMINAL_OUTPUT_FRAME &&
    type !== TERMINAL_SNAPSHOT_FRAME &&
    type !== TERMINAL_SNAPSHOT_CONTINUATION_FRAME
  )
    throw new Error("Terminal server frame type is invalid");
  const offset = Number(view.getBigUint64(5));
  checkedOffset(offset);
  return {
    kind:
      type === TERMINAL_SNAPSHOT_FRAME
        ? "snapshot"
        : type === TERMINAL_SNAPSHOT_CONTINUATION_FRAME
          ? "snapshot-continuation"
          : "output",
    resizeRevision: view.getUint32(1),
    offset,
    data: bytes.slice(TERMINAL_SERVER_HEADER_BYTES),
  };
}
