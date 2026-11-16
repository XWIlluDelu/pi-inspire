import { resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  CHECKPOINT_CHUNK_CHARS,
  CHECKPOINT_MAX_CHARS,
  CHECKPOINT_MAX_ENTRIES,
  CHECKPOINT_SUFFIX,
  NATIVE_START_SUFFIX,
  type WorkerCheckpoint,
} from "../shared/worker-checkpoint.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import type { RuntimeSlot, WorkerView } from "./runtime-slot.js";
import { WorkerEntryIndex } from "./session-projection.js";

export function createWorkerView(
  slot: RuntimeSlot,
  entries: readonly SessionEntry[],
  leaf: string | null,
  fileNameForPath?: (path: string) => string | null,
): WorkerView {
  const index = new WorkerEntryIndex(
    { id: slot.id, path: slot.sessionPath! },
    fileNameForPath,
  );
  index.appendWorkerEntries(entries, leaf);
  return {
    index,
    navigationLeased: false,
    contextGeneration: 1,
    finishedMessages: new Map(),
    sealedCursor: entries.at(-1)?.id ?? null,
    nativeLeafId: leaf,
    entryTurns: new Map(),
  };
}

function parseMarker(raw: string, slot: RuntimeSlot): WorkerCheckpoint {
  if (raw.length > 8_192) throw new Error("Native checkpoint marker too large");
  const marker: WorkerCheckpoint = JSON.parse(raw);
  const id = (value: unknown) =>
    value === null ||
    (typeof value === "string" && value.length > 0 && value.length <= 200);
  if (
    !marker ||
    marker.workerId !== slot.bridge?.workerId ||
    marker.sessionId !== slot.id ||
    typeof marker.sessionFile !== "string" ||
    !slot.sessionPath ||
    resolve(slot.cwd, marker.sessionFile) !== resolve(slot.sessionPath) ||
    !Number.isSafeInteger(marker.contextGeneration) ||
    marker.contextGeneration < 1 ||
    !Number.isSafeInteger(marker.run) ||
    marker.run < 0 ||
    !id(marker.from) ||
    !id(marker.tail) ||
    !id(marker.leaf) ||
    !Number.isSafeInteger(marker.entries) ||
    marker.entries < 0 ||
    marker.entries > CHECKPOINT_MAX_ENTRIES ||
    ![null, "turn", "settled", "idle"].includes(marker.sealed)
  )
    throw new Error("Invalid Pi native checkpoint");
  return marker;
}

interface Batch {
  marker: WorkerCheckpoint;
  entries: SessionEntry[];
  parts: string[];
  chars: number;
}

export class WorkerCheckpointReader {
  private readonly batches = new WeakMap<PiRpcProcess, Batch>();
  private readonly requested = new WeakMap<PiRpcProcess, { dirty: boolean }>();

  constructor(
    private readonly host: {
      commit(slot: RuntimeSlot, rpc: PiRpcProcess, batch: Batch): void;
      report(slot: RuntimeSlot, error: unknown): void;
    },
  ) {}

  observe(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    record: Record<string, unknown>,
  ): boolean {
    if (
      slot.bridge &&
      record.type === "extension_ui_request" &&
      record.method === "setStatus" &&
      record.statusKey === `${slot.bridge.statusKey}${NATIVE_START_SUFFIX}`
    ) {
      if (
        slot.startupPhase === "starting" &&
        typeof record.statusText === "string" &&
        record.statusText.length <= 8192
      ) {
        try {
          slot.nativeStart = JSON.parse(record.statusText);
        } catch {
          slot.nativeStart = {};
        }
      }
      return true;
    }
    if (
      !slot.bridge ||
      record.type !== "extension_ui_request" ||
      record.method !== "setStatus" ||
      record.statusKey !== `${slot.bridge.statusKey}${CHECKPOINT_SUFFIX}`
    )
      return false;
    if (!slot.workerView) return true;
    try {
      const raw = record.statusText;
      if (typeof raw !== "string") throw new Error("Invalid checkpoint frame");
      let batch = this.batches.get(rpc);
      if (raw.startsWith("{")) {
        if (batch) throw new Error("Incomplete Pi checkpoint");
        batch = {
          marker: parseMarker(raw, slot),
          entries: [],
          parts: [],
          chars: 0,
        };
        this.batches.set(rpc, batch);
      } else if (
        batch &&
        (raw[0] === "+" || raw[0] === "!") &&
        raw.length > 1 &&
        raw.length <= CHECKPOINT_CHUNK_CHARS + 1
      ) {
        batch.chars += raw.length - 1;
        if (batch.chars > CHECKPOINT_MAX_CHARS)
          throw new Error("Pi checkpoint exceeds its bound");
        batch.parts.push(raw.slice(1));
        if (raw[0] === "!") {
          batch.entries.push(JSON.parse(batch.parts.join("")));
          batch.parts.length = 0;
        }
      } else {
        if (raw.startsWith("Native checkpoint "))
          throw new Error(raw.slice(0, 200));
        throw new Error("Unexpected Pi checkpoint frame");
      }
      if (batch.entries.length === batch.marker.entries) {
        this.batches.delete(rpc);
        if (
          (batch.entries.at(-1)?.id ?? batch.marker.from) !== batch.marker.tail
        )
          throw new Error("Pi checkpoint cursor does not match its entries");
        this.host.commit(slot, rpc, batch);
      }
    } catch (error) {
      this.batches.delete(rpc);
      this.host.report(slot, error);
    }
    return true;
  }

  refresh(slot: RuntimeSlot): void {
    const { process: rpc, bridge, workerView } = slot;
    if (!rpc || !bridge || !workerView) return;
    const queued = this.requested.get(rpc);
    if (queued) {
      queued.dirty = true;
      return;
    }
    const state = { dirty: false };
    this.requested.set(rpc, state);
    void rpc
      .request(
        {
          type: "prompt",
          message: `/${bridge.command}${CHECKPOINT_SUFFIX}`,
        },
        30_000,
      )
      .catch((error) => {
        if (slot.process === rpc) this.host.report(slot, error);
      })
      .finally(() => {
        this.requested.delete(rpc);
        if (state.dirty && slot.process === rpc) this.refresh(slot);
      });
  }
}
