import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  appendFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticLogger } from "../../server/diagnostics.js";
import type { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimePersistenceOwnershipController } from "../../server/runtime-persistence-ownership.js";
import {
  deferredExpectation,
  exactEntryExpectation,
} from "../../server/runtime-persistence.js";
import { RuntimeProjectionCoordinator } from "../../server/runtime-projection-coordinator.js";
import { createRuntimeSlot } from "../../server/runtime-slot.js";
import { SessionProjection } from "../../server/session-projection.js";

const cleanups: Array<() => Promise<void>> = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const entry = (id: string, parentId: string | null): SessionEntry => ({
  type: "custom",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  customType: "synthetic",
  data: {},
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inspire-reconciliation-"));
  const path = join(directory, "synthetic.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: "synthetic",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: directory,
  };
  const base = entry("base", null);
  await writeFile(path, `${JSON.stringify(header)}\n${JSON.stringify(base)}\n`);
  const projection = await SessionProjection.open({
    id: header.id,
    path,
    cwd: directory,
    source: null,
    created: new Date(),
    modified: new Date(),
    messageCount: 0,
    firstMessage: "",
    searchText: "",
  });
  // Suppress autonomous watcher timing. Explicit reads still use the ordinary
  // production reconciliation method/FIFO; individual tests trigger hints directly.
  await projection.suspendReconciliation();
  const internals = projection as unknown as {
    reconciliationResume: Promise<void> | null;
    hintReading: boolean;
    reconcileFromHint(): void;
    reportHealthFailure(error: unknown): void;
  };
  internals.reconciliationResume = null;
  const durableEntries = [base];
  const witnessEntered = deferred();
  let witnessGate: Promise<void> = Promise.resolve();
  const worker = {
    request: vi.fn(async (command: Record<string, unknown>) => {
      if (command.type !== "get_entries")
        throw new Error("Unexpected fixture RPC");
      witnessEntered.resolve();
      await witnessGate;
      const since = durableEntries.findIndex(
        (value) => value.id === command.since,
      );
      return {
        entries: structuredClone(durableEntries.slice(since + 1)),
        leafId: durableEntries.at(-1)!.id,
      };
    }),
  } as unknown as PiRpcProcess;
  const slot = createRuntimeSlot({
    id: header.id,
    cwd: directory,
    sessionPath: path,
    process: worker,
    projection,
    preview: null,
    bridge: null,
    branchRevision: 0,
    incarnationId: "synthetic",
    viewId: "synthetic",
  });
  slot.runState = "running";
  slot.ready = true;
  const record = vi.fn<DiagnosticLogger["record"]>();
  const diagnostics: DiagnosticLogger = {
    hostId: "synthetic",
    record,
    async flush() {},
    async close() {},
  };
  const owner = new RuntimePersistenceOwnershipController(
    {
      async readNewSessionEntries() {
        return structuredClone(durableEntries);
      },
    },
    diagnostics,
  );
  const host = {
    isClosing: () => false,
    reconcileOverlay: vi.fn(),
    appendedEntriesOwnership: vi.fn((current, result) =>
      owner.appendedEntriesOwnership(current, result),
    ),
    setProjectionConflict: vi.fn(
      (current, kind, message) =>
        (current.conflict ??= { kind, message, incidentId: "synthetic" }),
    ),
    stopWriter: vi.fn(async (current) => {
      current.process = null;
    }),
    renewView: vi.fn(),
    emitSlotEvent: vi.fn(),
    logRuntimeError: vi.fn(),
  } satisfies ConstructorParameters<typeof RuntimeProjectionCoordinator>[0];
  const coordinator = new RuntimeProjectionCoordinator(host, diagnostics);
  coordinator.captureWriterBaseline(slot);
  coordinator.attach(slot, projection);
  cleanups.push(async () => {
    coordinator.clearPartialPersistence(slot);
    await projection.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    path,
    projection,
    slot,
    worker,
    host,
    record,
    coordinator,
    durableEntries,
    witnessEntered,
    holdWitness(gate: Promise<void>) {
      witnessGate = gate;
    },
    async append(value: SessionEntry) {
      durableEntries.push(value);
      await appendFile(path, `${JSON.stringify(value)}\n`);
    },
    hint() {
      internals.reconcileFromHint();
    },
    hintReading() {
      return internals.hintReading;
    },
    failWatch() {
      internals.reportHealthFailure(new Error("Synthetic watch failure"));
    },
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// The short observation window below releases no execution or mutation authority.
// It checks that a queued observer cannot finish while its predecessor is held.
async function stillWaiting(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(() => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), 75)),
  ]);
}

describe("runtime projection reconciliation ownership", () => {
  it.each(["explicit", "hint"] as const)(
    "orders a %s read and its ownership commit ahead of a later explicit read",
    async (trigger) => {
      const f = await fixture();
      const gate = deferred();
      f.holdWitness(gate.promise);
      await f.append(entry("a", "base"));
      const first =
        trigger === "explicit"
          ? f.coordinator.reconcile(f.slot, true)
          : (f.hint(), null);
      await f.witnessEntered.promise;
      try {
        await f.append(entry("b", "a"));
        const second = f.coordinator.reconcile(f.slot, true);
        expect(await stillWaiting(second)).toBe(true);
        expect(f.projection.revision).toBe(2);
        gate.resolve();
        await first;
        await second;
        expect(f.host.stopWriter).not.toHaveBeenCalled();
        expect(f.slot.conflict).toBeNull();
        expect(f.coordinator.writerBaselineMatches(f.slot)).toBe(true);
        expect(f.slot.workerProjectionRevision).toBe(3);
        expect(
          f.host.appendedEntriesOwnership.mock.calls.map(
            ([, result]) => result.previousRevision,
          ),
        ).toEqual([1, 2]);
      } finally {
        gate.resolve();
        await first;
      }
    },
  );

  it("holds later hints behind an explicit ownership check and coalesces a hint burst", async () => {
    const f = await fixture();
    const gate = deferred();
    f.holdWitness(gate.promise);
    const reads = vi.spyOn(f.projection, "reconcile");
    await f.append(entry("a", "base"));
    const first = f.coordinator.reconcile(f.slot, true);
    await f.witnessEntered.promise;
    try {
      await f.append(entry("b", "a"));
      for (let index = 0; index < 1000; index += 1) f.hint();
      // One explicit observation and one pending hint, not 1000 queued reads.
      expect(reads).toHaveBeenCalledTimes(2);
      expect(f.projection.revision).toBe(2);
      gate.resolve();
      await first;
      await vi.waitFor(() => {
        expect(f.hintReading()).toBe(false);
        expect(f.projection.leafId).toBe("b");
      });
      // At most one catch-up read follows the coalesced dirty hint.
      expect(reads).toHaveBeenCalledTimes(3);
      expect(f.coordinator.writerBaselineMatches(f.slot)).toBe(true);
      expect(f.host.stopWriter).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await first;
    }
  });

  it("orders watch failures after an outstanding ownership check", async () => {
    const f = await fixture();
    const gate = deferred();
    f.holdWitness(gate.promise);
    await f.append(entry("a", "base"));
    const first = f.coordinator.reconcile(f.slot, true);
    await f.witnessEntered.promise;
    try {
      f.failWatch();
      expect(f.projection.health.status).toBe("ok");
      expect(f.host.stopWriter).not.toHaveBeenCalled();
      gate.resolve();
      await first;
      await vi.waitFor(() =>
        expect(f.slot.conflict?.kind).toBe("projection-failure"),
      );
      expect(f.host.stopWriter).toHaveBeenCalledTimes(1);
      expect(f.host.appendedEntriesOwnership).toHaveBeenCalledTimes(1);
      expect(
        f.record.mock.calls.some(
          ([, event, fields]) =>
            event === "persistence_ownership_decision" &&
            fields?.owned === true,
        ),
      ).toBe(true);
    } finally {
      gate.resolve();
      await first;
    }
  });

  it("discards a pending result after its projection is retired", async () => {
    const f = await fixture();
    const gate = deferred();
    f.holdWitness(gate.promise);
    await f.append(entry("a", "base"));
    const first = f.coordinator.reconcile(f.slot, true);
    const rejected = expect(first).rejects.toMatchObject({ status: 409 });
    await f.witnessEntered.promise;
    f.slot.projection = null;
    f.coordinator.clearWriterBaseline(f.slot);
    gate.resolve();
    await rejected;
    expect(f.slot.workerProjectionRevision).toBeNull();
    expect(f.slot.conflict).toBeNull();
    expect(f.host.stopWriter).not.toHaveBeenCalled();
    expect(f.host.emitSlotEvent).not.toHaveBeenCalled();
  });

  it("does not revive a writer baseline or manufacture a conflict when Stop retires a pending witness", async () => {
    const f = await fixture();
    const gate = deferred();
    f.holdWitness(gate.promise);
    await f.append(entry("a", "base"));
    const reading = f.coordinator.reconcile(f.slot, true);
    await f.witnessEntered.promise;
    f.slot.process = null;
    f.coordinator.clearWriterBaseline(f.slot);
    gate.resolve();
    await reading;
    expect(f.slot.workerProjectionRevision).toBeNull();
    expect(f.slot.conflict).toBeNull();
    expect(f.host.stopWriter).not.toHaveBeenCalled();
  });

  it("does not consume claims after their writer is retired while waiting for a deferred receipt", async () => {
    const f = await fixture();
    const value = entry("a", "base");
    const claim = deferredExpectation();
    f.slot.persistenceExpectations.push(claim);
    await f.append(value);
    const reading = f.coordinator.reconcile(f.slot, true);
    await vi.waitFor(() =>
      expect(f.host.appendedEntriesOwnership).toHaveBeenCalledTimes(1),
    );
    f.slot.process = null;
    f.coordinator.clearWriterBaseline(f.slot);
    claim.settle(exactEntryExpectation(value).matcher);
    await reading;
    expect(
      await f.host.appendedEntriesOwnership.mock.results[0]!.value,
    ).toMatchObject({ owned: false });
    expect(f.slot.persistenceExpectations).toEqual([claim]);
    expect(f.slot.conflict).toBeNull();
    expect(f.host.stopWriter).not.toHaveBeenCalled();
  });

  it("consumes only matched claim identities when an earlier claim is removed during a later receipt", async () => {
    const f = await fixture();
    const a = entry("a", "base");
    const b = entry("b", "a");
    const firstClaim = exactEntryExpectation(a);
    const secondClaim = deferredExpectation();
    const futureClaim = exactEntryExpectation(entry("c", "b"));
    const matchingStarted = deferred();
    const match = firstClaim.matcher!;
    firstClaim.matcher = (candidate) => {
      matchingStarted.resolve();
      return match(candidate);
    };
    f.slot.persistenceExpectations.push(firstClaim, secondClaim);
    await f.append(a);
    await f.append(b);
    const reading = f.coordinator.reconcile(f.slot, true);
    await matchingStarted.promise;
    f.slot.persistenceExpectations.splice(0, 1);
    f.slot.persistenceExpectations.push(futureClaim);
    secondClaim.settle(exactEntryExpectation(b).matcher);
    await reading;
    expect(f.slot.persistenceExpectations).toEqual([futureClaim]);
    expect(f.coordinator.writerBaselineMatches(f.slot)).toBe(true);
    expect(f.host.stopWriter).not.toHaveBeenCalled();
  });

  it.each(["running", "compacting", "idle"] as const)(
    "revalidates unchanged complete bytes in %s without treating metadata as a new append",
    async (runState) => {
      const f = await fixture();
      f.slot.runState = runState;
      const version = f.slot.workerProjectionSourceVersion;
      const claim = exactEntryExpectation(entry("future", "base"));
      f.slot.persistenceExpectations.push(claim);
      const details = await stat(f.path);
      await utimes(f.path, details.atime, new Date(details.mtimeMs + 5000));
      const result = await f.coordinator.reconcile(f.slot, true);
      expect(result).toMatchObject({
        changed: false,
        sourceChanged: true,
        verifiedUnchangedContent: true,
      });
      expect(f.slot.workerProjectionSourceVersion).not.toBe(version);
      expect(f.coordinator.writerBaselineMatches(f.slot)).toBe(true);
      expect(f.slot.process).toBe(f.worker);
      expect(f.slot.conflict).toBeNull();
      expect(f.host.stopWriter).not.toHaveBeenCalled();
      expect(f.host.appendedEntriesOwnership).not.toHaveBeenCalled();
      expect(f.slot.persistenceExpectations).toEqual([claim]);
      expect(f.slot.branchRevision).toBe(0);
      expect(f.host.renewView).not.toHaveBeenCalled();
      expect(
        f.record.mock.calls.some(
          ([, event]) => event === "projection_metadata_revalidated",
        ),
      ).toBe(true);
    },
  );

  it("retains the compaction and same writer across a metadata-only observation and a following append", async () => {
    const f = await fixture();
    f.slot.runState = "compacting";
    await f.append({
      type: "compaction",
      id: "compact",
      parentId: "base",
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "Synthetic fixture only",
      firstKeptEntryId: "base",
      tokensBefore: 100,
    });
    await f.coordinator.reconcile(f.slot, true);
    expect(f.coordinator.writerBaselineMatches(f.slot)).toBe(true);
    const details = await stat(f.path);
    await utimes(f.path, details.atime, new Date(details.mtimeMs + 5000));
    await f.coordinator.reconcile(f.slot, true);
    f.slot.runState = "running";
    await f.append(entry("next", "compact"));
    await f.coordinator.reconcile(f.slot, true);
    expect(f.projection.entry("compact")?.type).toBe("compaction");
    expect(f.slot.process).toBe(f.worker);
    expect(f.slot.conflict).toBeNull();
    expect(f.coordinator.writerBaselineMatches(f.slot)).toBe(true);
    expect(f.host.stopWriter).not.toHaveBeenCalled();
  });

  it.each(["replacement", "changed-bytes", "foreign-append"])(
    "still fences %s",
    async (change) => {
      const f = await fixture();
      const bytes = await readFile(f.path, "utf8");
      if (change === "replacement") {
        await writeFile(`${f.path}.replacement`, bytes);
        await rename(`${f.path}.replacement`, f.path);
      } else if (change === "changed-bytes") {
        await writeFile(
          f.path,
          bytes.replace('"customType":"synthetic"', '"customType":"different"'),
        );
      } else {
        await appendFile(
          f.path,
          `${JSON.stringify(entry("foreign", "base"))}\n`,
        );
      }
      await f.coordinator.reconcile(f.slot, true);
      expect(f.slot.conflict?.kind).toBe("external-change");
      expect(f.host.stopWriter).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves source-version movement for the startup attestor instead of refreshing its baseline", async () => {
    const f = await fixture();
    await f.projection.suspendReconciliation();
    const version = f.slot.workerProjectionSourceVersion;
    const details = await stat(f.path);
    await utimes(f.path, details.atime, new Date(details.mtimeMs + 5000));
    const result = await f.coordinator.reconcile(f.slot, true, true);
    expect(result.sourceChanged).toBe(true);
    expect(f.slot.workerProjectionSourceVersion).toBe(version);
    expect(f.coordinator.writerBaselineMatches(f.slot)).toBe(false);
    expect(
      f.record.mock.calls.some(
        ([, event]) => event === "projection_metadata_revalidated",
      ),
    ).toBe(false);
  });

  it("does not refresh a stale writer baseline just because bytes are unchanged", async () => {
    const f = await fixture();
    f.slot.workerProjectionFingerprint = "stale";
    const details = await stat(f.path);
    await utimes(f.path, details.atime, new Date(details.mtimeMs + 5000));
    await f.coordinator.reconcile(f.slot, true);
    expect(f.slot.conflict?.kind).toBe("external-change");
    expect(f.host.stopWriter).toHaveBeenCalledTimes(1);
  });

  it("does not extend incomplete-tail ownership with a same-byte timestamp change", async () => {
    const f = await fixture();
    await appendFile(f.path, '{"type":"custom"');
    await f.coordinator.reconcile(f.slot, true);
    expect(f.slot.pendingPartialPersistence).not.toBeNull();
    const details = await stat(f.path);
    await utimes(f.path, details.atime, new Date(details.mtimeMs + 5000));
    const result = await f.coordinator.reconcile(f.slot, true);
    expect(result.verifiedUnchangedContent).toBeUndefined();
    expect(f.slot.conflict?.kind).toBe("incomplete-persistence");
    expect(f.host.stopWriter).toHaveBeenCalledTimes(1);
  });
});
