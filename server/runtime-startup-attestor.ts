import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { MAX_RPC_LINE_BYTES, type PiRpcProcess } from "./pi-rpc.js";
import { samePersistedJson } from "./persisted-json.js";
import { parseRpcEntryChain } from "./runtime-entry-chain.js";
import type { RuntimeSlot } from "./runtime-slot.js";
import type {
  ProjectionReconcileResult,
  SessionProjectionView,
} from "./session-projection.js";

const STARTUP_DELTA_MAX_BYTES = 16 * 1024;
const STARTUP_DELTA_MAX_ENTRIES = 16;

export interface StartupProjectionBaseline {
  revision: number;
  fingerprint: string;
  sourceIdentity: string | null;
  sourceVersion: string | null;
  committedBytes: number;
  uncommittedBytes: number;
  uncommittedFingerprint: string | null;
  tailEntryId: string | null;
  leafId: string | null;
  missingThinkingLevel: boolean;
}

/**
 * The startup boundary proves that the suspended projection and Pi's initial
 * RPC state still describe one tightly bounded, contiguous session lineage.
 * It does not claim causal authorship; the one-writer operating rule remains
 * the authority outside this fail-closed attestation.
 */
export interface RuntimeStartupAttestorHost {
  reconcile(
    slot: RuntimeSlot,
    force?: boolean,
    startupAttestation?: boolean,
  ): Promise<ProjectionReconcileResult>;
}

export class RuntimeStartupAttestor {
  constructor(private readonly host: RuntimeStartupAttestorHost) {}

  capture(projection: SessionProjectionView): StartupProjectionBaseline {
    return {
      revision: projection.revision,
      fingerprint: projection.fingerprint,
      sourceIdentity: projection.sourceIdentity,
      sourceVersion: projection.sourceVersion,
      committedBytes: projection.committedBytes,
      uncommittedBytes: projection.uncommittedBytes,
      uncommittedFingerprint: projection.uncommittedFingerprint,
      tailEntryId: projection.tailEntryId,
      leafId: projection.leafId,
      missingThinkingLevel: !projection.hasActiveEntryType(
        "thinking_level_change",
      ),
    };
  }

  async requireUnchangedPreStartBaseline(
    slot: RuntimeSlot,
    baseline: StartupProjectionBaseline,
  ): Promise<void> {
    const reconciled = await this.host.reconcile(slot, true, true);
    const projection = slot.projection;
    if (
      !projection ||
      projection.health.status === "error" ||
      reconciled.changed ||
      reconciled.healthChanged ||
      reconciled.sourceChanged ||
      reconciled.kind !== "none" ||
      reconciled.previousRevision !== baseline.revision ||
      reconciled.revision !== baseline.revision ||
      reconciled.previousFingerprint !== baseline.fingerprint ||
      reconciled.fingerprint !== baseline.fingerprint ||
      projection.revision !== baseline.revision ||
      projection.fingerprint !== baseline.fingerprint ||
      projection.sourceIdentity !== baseline.sourceIdentity ||
      projection.sourceVersion !== baseline.sourceVersion ||
      projection.committedBytes !== baseline.committedBytes ||
      projection.uncommittedBytes !== baseline.uncommittedBytes ||
      projection.uncommittedFingerprint !== baseline.uncommittedFingerprint ||
      projection.uncommittedBytes > 0 ||
      projection.tailEntryId !== baseline.tailEntryId ||
      projection.leafId !== baseline.leafId
    ) {
      throw Object.assign(
        new Error(
          "Session changed after worker creation but before Pi startup",
        ),
        { status: 409 },
      );
    }
  }

  async attest(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    baseline: StartupProjectionBaseline,
  ): Promise<void> {
    const fail = (): never => {
      throw Object.assign(
        new Error(
          "Session changed on disk while the Pi runtime was starting; retry after reconciliation",
        ),
        { status: 409 },
      );
    };
    if (
      baseline.tailEntryId !== baseline.leafId ||
      baseline.uncommittedBytes > 0
    )
      fail();
    const rpcEntries = await rpc.request<{
      entries?: unknown;
      leafId?: unknown;
    }>({
      type: "get_entries",
      ...(baseline.tailEntryId === null ? {} : { since: baseline.tailEntryId }),
    });
    const parsedRpcEntries = (() => {
      try {
        return parseRpcEntryChain(rpcEntries, {
          expectedParentId: baseline.tailEntryId,
          maxEntries: STARTUP_DELTA_MAX_ENTRIES,
          maxBytes: STARTUP_DELTA_MAX_BYTES,
          label: "startup",
        });
      } catch {
        return fail();
      }
    })();
    const state = await rpc.request<Record<string, unknown>>({
      type: "get_state",
    });
    if (
      state.sessionId !== slot.id ||
      typeof state.sessionFile !== "string" ||
      resolve(state.sessionFile) !== resolve(slot.sessionPath!) ||
      typeof state.thinkingLevel !== "string"
    )
      fail();
    const reconciled = await this.host.reconcile(slot, true, true);
    if (!slot.projection) fail();
    const projection = slot.projection as SessionProjectionView;
    if (
      projection.health.status === "error" ||
      projection.sourceIdentity !== baseline.sourceIdentity ||
      projection.uncommittedBytes > 0
    )
      fail();

    const delta = parsedRpcEntries.entries;
    if (!reconciled.changed) {
      if (
        reconciled.kind !== "none" ||
        reconciled.sourceChanged ||
        projection.revision !== baseline.revision ||
        projection.fingerprint !== baseline.fingerprint ||
        delta.length !== 0 ||
        parsedRpcEntries.leafId !== baseline.leafId ||
        projection.leafId !== baseline.leafId
      )
        fail();
      return;
    }

    const appendedEntries = reconciled.appendedEntries;
    // Pi core may initialize a missing thinking level, and installed extensions
    // may persist their own custom state from session_start. Accept only a
    // small, contiguous append reported byte-for-byte by this worker.
    if (
      reconciled.kind !== "append" ||
      reconciled.healthChanged ||
      reconciled.previousRevision !== baseline.revision ||
      reconciled.previousFingerprint !== baseline.fingerprint ||
      reconciled.previousLeafId !== baseline.leafId ||
      projection.revision !== baseline.revision + 1 ||
      projection.committedBytes <= baseline.committedBytes ||
      projection.committedBytes >
        baseline.committedBytes + STARTUP_DELTA_MAX_BYTES ||
      !Array.isArray(appendedEntries) ||
      appendedEntries.length !== delta.length ||
      delta.length === 0
    )
      fail();

    let sawThinkingInitializer = false;
    for (let index = 0; index < delta.length; index += 1) {
      const rpcEntry = delta[index]!;
      const projectedEntry = (appendedEntries as readonly SessionEntry[])[
        index
      ];
      if (!projectedEntry || !samePersistedJson(projectedEntry, rpcEntry))
        fail();
      const record = rpcEntry as unknown as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      if (record.type === "custom") {
        if (
          typeof record.customType !== "string" ||
          record.customType.length === 0 ||
          record.customType.length > 200 ||
          !isDeepStrictEqual(keys, [
            "customType",
            "data",
            "id",
            "parentId",
            "timestamp",
            "type",
          ])
        )
          fail();
      } else if (record.type === "thinking_level_change") {
        if (
          !baseline.missingThinkingLevel ||
          sawThinkingInitializer ||
          record.thinkingLevel !== state.thinkingLevel ||
          !isDeepStrictEqual(keys, [
            "id",
            "parentId",
            "thinkingLevel",
            "timestamp",
            "type",
          ])
        )
          fail();
        sawThinkingInitializer = true;
      } else {
        fail();
      }
    }

    if (
      projection.leafId !== parsedRpcEntries.leafId ||
      projection.tailEntryId !== parsedRpcEntries.leafId ||
      projection.thinkingLevel !== state.thinkingLevel
    )
      fail();
  }

  async readNewSessionEntries(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    maxEntries: number,
  ): Promise<SessionEntry[]> {
    const response = await rpc.request<Record<string, unknown>>({
      type: "get_entries",
    });
    if (slot.process !== rpc) {
      throw Object.assign(
        new Error(
          "The new-session worker changed while its entries were inspected",
        ),
        { status: 409 },
      );
    }
    return parseRpcEntryChain(response, {
      expectedParentId: null,
      maxEntries,
      maxBytes: MAX_RPC_LINE_BYTES,
      label: "new-session",
    }).entries;
  }
}
