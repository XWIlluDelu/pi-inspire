import { requestError } from "./request-error.js";
import { resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { MAX_RPC_LINE_BYTES, type PiRpcProcess } from "./pi-rpc.js";
import { samePersistedJson } from "./persisted-json.js";
import { parseRpcEntryChain } from "./runtime-entry-chain.js";
import type { RuntimeSlot } from "./runtime-slot.js";
import type {
  ProjectionReconcileResult,
  SessionProjectionView,
} from "./session-projection.js";

interface StartupProjectionBaseline {
  revision: number;
  fingerprint: string;
  sourceIdentity: string | null;
  sourceVersion: string | null;
  committedBytes: number;
  uncommittedBytes: number;
  uncommittedFingerprint: string | null;
  tailEntryId: string | null;
  leafId: string | null;
}

/**
 * The startup boundary proves that the suspended projection and Pi's initial
 * RPC state still describe one contiguous session lineage.
 * It does not claim causal authorship; the one-writer operating rule remains
 * the authority outside this fail-closed attestation.
 */
interface RuntimeStartupAttestorHost {
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
      throw requestError(
        "Session changed after worker creation but before Pi startup",
        409,
      );
    }
  }

  async attest(
    slot: RuntimeSlot,
    rpc: PiRpcProcess,
    baseline: StartupProjectionBaseline,
  ): Promise<void> {
    const fail = (): never => {
      throw requestError(
        "Session changed on disk while the Pi runtime was starting; retry after reconciliation",
        409,
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
          maxBytes: MAX_RPC_LINE_BYTES,
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
      resolve(slot.cwd, state.sessionFile) !== resolve(slot.sessionPath!) ||
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
    // Pi and its extensions own session_start persistence. Verify the worker's
    // complete append against disk, without imposing an entry-type policy.
    if (
      reconciled.kind !== "append" ||
      reconciled.healthChanged ||
      reconciled.previousRevision !== baseline.revision ||
      reconciled.previousFingerprint !== baseline.fingerprint ||
      reconciled.previousLeafId !== baseline.leafId ||
      projection.revision !== baseline.revision + 1 ||
      projection.committedBytes <= baseline.committedBytes ||
      !Array.isArray(appendedEntries) ||
      appendedEntries.length !== delta.length ||
      delta.length === 0
    )
      fail();

    for (let index = 0; index < delta.length; index += 1) {
      const rpcEntry = delta[index]!;
      const projectedEntry = (appendedEntries as readonly SessionEntry[])[
        index
      ];
      if (!projectedEntry || !samePersistedJson(projectedEntry, rpcEntry))
        fail();
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
      throw requestError(
        "The new-session worker changed while its entries were inspected",
        409,
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
