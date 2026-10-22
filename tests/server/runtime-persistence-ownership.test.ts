import {
  appendFile,
  readFile,
  rename,
  truncate,
  writeFile,
} from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiagnosticLogger } from "../../server/diagnostics.js";
import { PiRpcOutcomeUnknownError } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import type { RuntimePersistenceOwnershipController } from "../../server/runtime-persistence-ownership.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";
import { deferredSignal, waitForReady } from "./fixtures/runtime.js";
import {
  disposeProjectionFixture,
  setup,
} from "./fixtures/runtime-projection.js";

afterEach(disposeProjectionFixture);

describe("writer persistence ownership", () => {
  it("waits for the stale writer's confirmed retirement before starting its sole replacement", async () => {
    const { runtime, workers, path } = await setup();
    const retirement = deferredSignal();
    const stopping = deferredSignal();
    const stop = vi.spyOn(workers[0]!, "stop").mockImplementation(() => {
      stopping.resolve();
      return retirement.promise;
    });
    try {
      // Mutate an established writer, not a projection still being attested at startup.
      await waitForReady(runtime, "session-a");
      const external = {
        type: "message",
        id: "external",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:02.000Z",
        message: { role: "assistant", content: "terminal", timestamp: 2 },
      };
      await appendFile(path, `${JSON.stringify(external)}\n`);
      const prompting = runtime.prompt({
        sessionId: "session-a",
        message: "continue",
      });
      const accepted = expect(prompting).resolves.toBeNull();
      await stopping.promise;
      expect(stop).toHaveBeenCalledOnce();
      // Calling stop is not exit confirmation. No new writer may even start.
      await new Promise<void>((tick) => setImmediate(tick));
      expect(workers).toHaveLength(1);
      expect(
        workers[0]!.commands.filter((command) => command.type === "prompt"),
      ).toEqual([]);

      retirement.resolve();
      await accepted;
      expect(workers).toHaveLength(2);
      expect(stop).toHaveBeenCalledOnce();
      expect(
        workers[0]!.commands.some((command) => command.type === "prompt"),
      ).toBe(false);
      expect(
        workers[1]!.commands.filter((command) => command.type === "prompt"),
      ).toHaveLength(1);
      expect(
        workers
          .flatMap((worker) => worker.commands)
          .some((command) => command.type === "get_messages"),
      ).toBe(false);
    } finally {
      retirement.resolve();
      await runtime.close();
    }
  });

  it("serializes concurrent persistence operations through one freshness replacement", async () => {
    const { runtime, workers, path } = await setup();
    try {
      await appendFile(
        path,
        `${JSON.stringify({
          type: "message",
          id: "external",
          parentId: "u1",
          timestamp: "2026-08-01T00:00:02.000Z",
          message: { role: "assistant", content: "terminal", timestamp: 2 },
        })}\n`,
      );
      await Promise.all([
        runtime.rename("session-a", "first"),
        runtime.setThinkingLevel("session-a", "high"),
      ]);
      expect(workers).toHaveLength(2);
      expect(workers[0]!.stops).toBe(1);
      expect(
        workers[1]!.commands.filter(
          (command) => command.type === "set_session_name",
        ),
      ).toHaveLength(1);
      expect(
        workers[1]!.commands.filter(
          (command) => command.type === "set_thinking_level",
        ),
      ).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("refreshes stale writers for model and compact control families", async () => {
    const { runtime, workers, path } = await setup();
    try {
      await appendFile(
        path,
        `${JSON.stringify({
          type: "model_change",
          id: "external-model",
          parentId: "u1",
          timestamp: "2026-08-01T00:00:02.000Z",
          provider: "terminal",
          modelId: "model",
        })}\n`,
      );
      await runtime.setModel("session-a", "test", "fresh-model");
      expect(workers).toHaveLength(2);
      expect(
        workers[0]!.commands.some((command) => command.type === "set_model"),
      ).toBe(false);
      expect(
        workers[1]!.commands.some((command) => command.type === "set_model"),
      ).toBe(true);

      await appendFile(
        path,
        `${JSON.stringify({
          type: "thinking_level_change",
          id: "external-thinking",
          parentId: "external-model",
          timestamp: "2026-08-01T00:00:03.000Z",
          thinkingLevel: "high",
        })}\n`,
      );
      await runtime.prompt({ sessionId: "session-a", message: "/compact" });
      expect(workers).toHaveLength(3);
      expect(
        workers[1]!.commands.some((command) => command.type === "compact"),
      ).toBe(false);
      expect(
        workers[2]!.commands.some((command) => command.type === "compact"),
      ).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it("conflicts rather than answering a stale extension-blocked writer", async () => {
    const { runtime, workers, path } = await setup();
    try {
      workers[0]!.emit("event", {
        type: "extension_ui_request",
        id: "question",
        method: "confirm",
        title: "Proceed?",
      });
      await appendFile(
        path,
        `${JSON.stringify({
          type: "message",
          id: "external",
          parentId: "u1",
          timestamp: "2026-08-01T00:00:03.000Z",
          message: { role: "assistant", content: "terminal", timestamp: 3 },
        })}\n`,
      );
      await expect(
        runtime.extensionUiResponse({
          sessionId: "session-a",
          id: "question",
          confirmed: true,
        }),
      ).rejects.toThrow(/could not verify ownership/);
      expect(
        workers[0]!.commands.some(
          (command) => command.type === "extension_ui_response",
        ),
      ).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("verifies an owned compaction revision before rejecting the external revision queued behind it", async () => {
    const { runtime, workers, path } = await setup();
    const gate = deferredSignal();
    const started = deferredSignal();
    const internal = runtime as unknown as {
      persistenceOwnership: RuntimePersistenceOwnershipController;
      slots: Map<string, RuntimeSlot>;
    };
    const projection = internal.slots.get("session-a")!.projection!;
    const checks = vi.spyOn(
      internal.persistenceOwnership,
      "appendedEntriesOwnership",
    );
    try {
      const worker = workers[0]!;
      const original = worker.request.bind(worker);
      const compactionResult = {
        summary: "owned summary",
        firstKeptEntryId: "u1",
        tokensBefore: 100,
      };
      worker.request = async <T>(command: Record<string, unknown>) => {
        if (command.type !== "compact") return original<T>(command);
        await appendFile(
          path,
          `${JSON.stringify({
            type: "compaction",
            id: "owned-compaction",
            parentId: "u1",
            timestamp: "2026-08-01T00:00:02.000Z",
            ...compactionResult,
          })}\n`,
        );
        started.resolve();
        await gate.promise;
        return compactionResult as T;
      };
      const compacting = runtime.prompt({
        sessionId: "session-a",
        message: "/compact",
      });
      const accepted = expect(compacting).resolves.toBeNull();
      await started.promise;
      await vi.waitFor(() =>
        expect(
          checks.mock.calls[0]?.[1].appendedEntries?.map((entry) => entry.id),
        ).toEqual(["owned-compaction"]),
      );
      let firstVerified = false;
      void checks.mock.results[0]!.value.then(() => {
        firstVerified = true;
      });
      await appendFile(
        path,
        `${JSON.stringify({
          type: "message",
          id: "external-after",
          parentId: "owned-compaction",
          timestamp: "2026-08-01T00:00:03.000Z",
          message: {
            role: "assistant",
            content: "external revision",
            timestamp: 3,
          },
        })}\n`,
      );
      const externalObservation = projection.reconcile(true);
      await new Promise<void>((tick) => setImmediate(tick));
      // The first verification still awaits Pi's compaction receipt; neither a
      // watch hint nor the explicit next read may advance that observation.
      expect(firstVerified).toBe(false);
      expect(projection.leafId).toBe("owned-compaction");
      expect(checks).toHaveBeenCalledOnce();

      gate.resolve();
      await accepted;
      await externalObservation;
      expect(
        checks.mock.calls.map(([, result]) =>
          result.appendedEntries?.map((entry) => entry.id),
        ),
      ).toEqual([["owned-compaction"], ["external-after"]]);
      await expect(
        Promise.all(checks.mock.results.map((result) => result.value)),
      ).resolves.toMatchObject([{ owned: true }, { owned: false }]);
      expect((await runtime.snapshot()).runState).toBe("conflict");
    } finally {
      gate.resolve();
      await runtime.close();
    }
  });

  it("rejects same-type and mixed appends unless every entry exactly matches the owned operation order", async () => {
    const first = await setup();
    try {
      const worker = first.workers[0]!;
      const original = worker.request.bind(worker);
      worker.request = async <T>(command: Record<string, unknown>) => {
        const result = await original<T>(command);
        if (command.type === "set_session_name") {
          await appendFile(
            first.path,
            `${JSON.stringify({
              type: "session_info",
              id: "own-name",
              parentId: "u1",
              timestamp: "2026-08-01T00:00:02.000Z",
              name: "owned",
            })}\n${JSON.stringify({
              type: "session_info",
              id: "external-name",
              parentId: "own-name",
              timestamp: "2026-08-01T00:00:03.000Z",
              name: "external",
            })}\n`,
          );
        }
        return result;
      };
      await expect(first.runtime.rename("session-a", "owned")).rejects.toThrow(
        /could not verify ownership/,
      );
      expect((await first.runtime.snapshot()).runState).toBe("conflict");
    } finally {
      await first.runtime.close();
    }

    const second = await setup();
    try {
      const worker = second.workers[0]!;
      const original = worker.request.bind(worker);
      worker.request = async <T>(command: Record<string, unknown>) => {
        const result = await original<T>(command);
        if (command.type === "set_thinking_level") {
          await appendFile(
            second.path,
            `${JSON.stringify({
              type: "thinking_level_change",
              id: "own-thinking",
              parentId: "u1",
              timestamp: "2026-08-01T00:00:02.000Z",
              thinkingLevel: "high",
            })}\n${JSON.stringify({
              type: "message",
              id: "external-message",
              parentId: "own-thinking",
              timestamp: "2026-08-01T00:00:03.000Z",
              message: { role: "assistant", content: "external", timestamp: 3 },
            })}\n`,
          );
        }
        return result;
      };
      await expect(
        second.runtime.setThinkingLevel("session-a", "high"),
      ).rejects.toThrow(/could not verify ownership/);
      expect((await second.runtime.snapshot()).runState).toBe("conflict");
    } finally {
      await second.runtime.close();
    }
  });

  it("attests system and cache-usage entries without adding them to the browser transcript", async () => {
    const { runtime, workers, path } = await setup();
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) => events.push(event));
    try {
      const worker = workers[0]!;
      const system = {
        type: "message",
        id: "system-loadout",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:02.000Z",
        message: {
          role: "system",
          content: "host-only prompt",
          sections: { cwd: "/project" },
          toolsAdded: [],
          timestamp: 2,
        },
      };
      const usage = {
        type: "usage",
        id: "cache-usage",
        parentId: system.id,
        timestamp: "2026-08-01T00:00:03.000Z",
        kind: "cache_warm",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 100,
          cacheWrite: 0,
          totalTokens: 100,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0.01,
            cacheWrite: 0,
            total: 0.01,
          },
        },
      };
      worker.startupEntries = [system, usage];
      worker.startupLeafId = usage.id;
      worker.emit("event", { type: "agent_start" });
      worker.emit("event", { type: "message_start", message: system.message });
      worker.emit("event", { type: "entry_appended", entry: system });
      worker.emit("event", { type: "message_end", message: system.message });
      worker.emit("event", { type: "entry_appended", entry: usage });
      worker.emit("event", { type: "agent_end", messages: [system.message] });
      await new Promise<void>((done) => setImmediate(done));
      expect(events.find((event) => event.type === "agent_end")).toMatchObject({
        messages: [],
      });
      expect(JSON.stringify(events)).not.toContain("host-only prompt");
      expect(
        JSON.stringify((await runtime.snapshot()).active?.transcriptPage),
      ).not.toContain("host-only prompt");
      await appendFile(
        path,
        `${[system, usage].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      await expect(
        runtime.rename("session-a", "after Pi metadata"),
      ).resolves.toBeUndefined();
      const snapshot = await runtime.snapshot();
      expect(snapshot.active?.projectionConflict).toBeNull();
      expect(snapshot.active?.transcriptPage.messages).toHaveLength(1);
      expect(worker.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("accepts a large extension entry interleaved with tool-call and tool-result persistence", async () => {
    const { runtime, workers, path } = await setup();
    try {
      const worker = workers[0]!;
      const assistant = {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-1",
            name: "web_search",
            arguments: { query: "bounded" },
          },
        ],
        timestamp: 2,
        stopReason: "toolUse",
      };
      const toolResult = {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "web_search",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 3,
      };
      const entries = [
        {
          type: "message",
          id: "assistant-tool",
          parentId: "u1",
          timestamp: "2026-08-01T00:00:02.000Z",
          message: assistant,
        },
        {
          type: "custom",
          id: "extension-large",
          parentId: "assistant-tool",
          timestamp: "2026-08-01T00:00:02.500Z",
          customType: "web-search-results",
          data: { encoded: "x".repeat(150_000) },
        },
        {
          type: "custom",
          id: "extension-metadata",
          parentId: "extension-large",
          timestamp: "2026-08-01T00:00:02.750Z",
          customType: "web-search-metadata",
          data: { resultCount: 3 },
        },
        {
          type: "message",
          id: "tool-result",
          parentId: "extension-metadata",
          timestamp: "2026-08-01T00:00:03.000Z",
          message: toolResult,
        },
      ];
      worker.startupEntries = entries;
      worker.startupLeafId = "tool-result";
      worker.emit("event", { type: "agent_start" });
      worker.emit("event", {
        type: "message_end",
        message: structuredClone(assistant),
      });
      worker.emit("event", {
        type: "entry_appended",
        entry: structuredClone(entries[1]),
      });
      worker.emit("event", {
        type: "entry_appended",
        entry: structuredClone(entries[2]),
      });
      worker.emit("event", {
        type: "message_end",
        message: structuredClone(toolResult),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await appendFile(
        path,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );

      await expect(
        runtime.rename("session-a", "after interleaved extension append"),
      ).resolves.toBeUndefined();
      expect((await runtime.snapshot()).active?.projectionConflict).toBeNull();
      expect(worker.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("attests an owning extension append from get_entries when reconciliation wins the event race", async () => {
    const { runtime, workers, path } = await setup();
    try {
      const worker = workers[0]!;
      const entry = {
        type: "custom",
        id: "extension-race",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:02.000Z",
        customType: "web-search-results",
        data: { resultCount: 1 },
      };
      worker.startupEntries = [entry];
      worker.startupLeafId = entry.id;
      worker.emit("event", { type: "agent_start" });
      await appendFile(path, `${JSON.stringify(entry)}\n`);

      await expect(
        runtime.rename("session-a", "after watcher race"),
      ).resolves.toBeUndefined();
      expect((await runtime.snapshot()).active?.projectionConflict).toBeNull();
      expect(worker.commands).toContainEqual({
        type: "get_entries",
        since: "u1",
      });

      // Pi can emit entry_appended after the watcher callback. It must consume
      // the attested append instead of manufacturing a future claim.
      worker.emit("event", {
        type: "entry_appended",
        entry: structuredClone(entry),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(worker.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("accepts a worker witness that has advanced beyond the projection snapshot", async () => {
    const { runtime, workers, path } = await setup();
    try {
      const worker = workers[0]!;
      const observed = {
        type: "custom",
        id: "extension-observed",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:02.000Z",
        customType: "web-search-results",
        data: { resultCount: 1 },
      };
      const trailing = {
        type: "custom",
        id: "extension-trailing",
        parentId: observed.id,
        timestamp: "2026-08-01T00:00:03.000Z",
        customType: "ctx-status",
        data: { phase: "later" },
      };
      worker.startupEntries = [observed, trailing];
      worker.startupLeafId = trailing.id;
      worker.emit("event", { type: "agent_start" });
      await appendFile(path, `${JSON.stringify(observed)}\n`);

      await expect(
        runtime.rename("session-a", "accept advancing witness"),
      ).resolves.toBeUndefined();
      expect((await runtime.snapshot()).active?.projectionConflict).toBeNull();
      expect(worker.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("accepts an exact observed prefix when the same worker advances during witness lookup", async () => {
    const records: Array<{
      level: string;
      event: string;
      fields?: Record<string, unknown>;
    }> = [];
    const diagnostics: DiagnosticLogger = {
      hostId: "host-test",
      record: (level, event, fields) => records.push({ level, event, fields }),
      flush: async () => undefined,
      close: async () => undefined,
    };
    const { runtime, workers, path } = await setup(
      [],
      undefined,
      true,
      "",
      true,
      diagnostics,
    );
    let releaseWitness: (() => void) | undefined;
    try {
      const worker = workers[0]!;
      const observed = {
        type: "custom",
        id: "extension-observed",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:02.000Z",
        customType: "web-search-results",
        data: { resultCount: 1 },
      };
      const trailing = {
        type: "custom",
        id: "extension-trailing",
        parentId: observed.id,
        timestamp: "2026-08-01T00:00:03.000Z",
        customType: "ctx-status",
        data: { phase: "later" },
      };
      let markWitnessStarted!: () => void;
      const witnessStarted = new Promise<void>((resolve) => {
        markWitnessStarted = resolve;
      });
      const witnessGate = new Promise<void>((resolve) => {
        releaseWitness = resolve;
      });
      const originalRequest = worker.request.bind(worker);
      worker.request = async <T>(
        command: Record<string, unknown>,
      ): Promise<T> => {
        if (command.type !== "get_entries") return originalRequest<T>(command);
        markWitnessStarted();
        await witnessGate;
        return originalRequest<T>(command);
      };

      const getEntriesBefore = worker.commands.filter(
        (command) => command.type === "get_entries",
      ).length;
      worker.emit("event", { type: "agent_start" });
      worker.startupEntries = [observed];
      worker.startupLeafId = observed.id;
      await appendFile(path, `${JSON.stringify(observed)}\n`);

      const reconciling = runtime.rename(
        "session-a",
        "during worker advancement",
      );
      await witnessStarted;

      worker.startupEntries = [observed, trailing];
      worker.startupLeafId = trailing.id;
      await appendFile(path, `${JSON.stringify(trailing)}\n`);
      worker.emit("event", {
        type: "entry_appended",
        entry: structuredClone(observed),
      });
      worker.emit("event", {
        type: "entry_appended",
        entry: structuredClone(trailing),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      releaseWitness?.();

      await expect(reconciling).resolves.toBeUndefined();
      await expect(
        runtime.rename("session-a", "after worker advancement"),
      ).resolves.toBeUndefined();

      expect(
        worker.commands.filter((command) => command.type === "get_entries")
          .length - getEntriesBefore,
      ).toBe(1);
      expect(worker.stops).toBe(0);
      expect((await runtime.snapshot()).active?.projectionConflict).toBeNull();
      const witnessed = records.find(
        (record) =>
          record.event === "persistence_ownership_decision" &&
          record.fields?.owned === true &&
          record.fields?.workerWitness !== undefined,
      );
      expect(witnessed?.fields?.workerWitness).toEqual({
        observedEntries: 1,
        workerEntries: 2,
        aheadBy: 1,
        observedLeafId: observed.id,
        workerLeafId: trailing.id,
      });
    } finally {
      releaseWitness?.();
      await runtime.close();
    }
  });

  it("rejects a worker witness whose observed prefix differs in persisted content", async () => {
    const { runtime, workers, path } = await setup();
    try {
      const worker = workers[0]!;
      const workerEntry = {
        type: "custom",
        id: "same-entry-id",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:02.000Z",
        customType: "web-search-results",
        data: { owner: "worker" },
      };
      const diskEntry = {
        ...workerEntry,
        data: { owner: "external" },
      };
      worker.startupEntries = [workerEntry];
      worker.startupLeafId = workerEntry.id;
      worker.emit("event", { type: "agent_start" });
      await appendFile(path, `${JSON.stringify(diskEntry)}\n`);

      await expect(
        runtime.rename("session-a", "must reject mismatched prefix"),
      ).rejects.toThrow(/could not verify ownership/);
      expect((await runtime.snapshot()).active?.projectionConflict?.kind).toBe(
        "external-change",
      );
      expect(worker.stops).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("still rejects a custom entry that the active worker cannot attest", async () => {
    const records: Array<{
      level: string;
      event: string;
      fields?: Record<string, unknown>;
    }> = [];
    const diagnostics: DiagnosticLogger = {
      hostId: "host-test",
      record: (level, event, fields) => records.push({ level, event, fields }),
      flush: async () => undefined,
      close: async () => undefined,
    };
    const { runtime, workers, path } = await setup(
      [],
      undefined,
      true,
      "",
      true,
      diagnostics,
    );
    try {
      const worker = workers[0]!;
      worker.emit("event", { type: "agent_start" });
      await appendFile(
        path,
        `${JSON.stringify({
          type: "custom",
          id: "external-custom",
          parentId: "u1",
          timestamp: "2026-08-01T00:00:02.000Z",
          customType: "web-search-results",
          data: { external: true },
        })}\n`,
      );

      await expect(
        runtime.rename("session-a", "must not write"),
      ).rejects.toThrow(/could not verify ownership/);
      const conflict = (await runtime.snapshot()).active?.projectionConflict;
      expect(conflict).toMatchObject({ kind: "external-change" });
      expect(conflict?.incidentId).toMatch(/^inc_[A-Za-z0-9_-]+$/);
      const decision = records.find(
        (record) =>
          record.event === "persistence_ownership_decision" &&
          record.fields?.owned === false,
      );
      expect(decision?.fields).toMatchObject({
        ownershipRejection: "worker-entry-mismatch",
        workerWitness: {
          observedEntries: 1,
          workerEntries: 0,
          aheadBy: 0,
          observedLeafId: "external-custom",
          workerLeafId: "u1",
        },
      });
      const incident = records.find(
        (record) => record.event === "projection_conflict",
      );
      expect(incident?.fields).toMatchObject({
        incidentId: conflict?.incidentId,
        sessionId: "session-a",
        conflictKind: "external-change",
        ownershipRejection: "worker-entry-mismatch",
        workerWitness: {
          observedEntries: 1,
          workerEntries: 0,
          aheadBy: 0,
          observedLeafId: "external-custom",
          workerLeafId: "u1",
        },
      });
      expect(JSON.stringify(records)).not.toContain('"external":true');
      expect(worker.stops).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("enters an addressed conflict on busy divergence, refuses mutation, and still allows abort", async () => {
    const { runtime, workers, path } = await setup();
    try {
      workers[0]!.emit("event", { type: "agent_start" });
      await appendFile(
        path,
        `${JSON.stringify({
          type: "message",
          id: "external",
          parentId: "u1",
          timestamp: "2026-08-01T00:00:03.000Z",
          message: {
            role: "assistant",
            content: "concurrent terminal",
            timestamp: 3,
          },
        })}\n`,
      );
      await expect(
        runtime.rename("session-a", "must not write"),
      ).rejects.toThrow(/could not verify ownership/);
      expect(
        workers[0]!.commands.some(
          (command) => command.type === "set_session_name",
        ),
      ).toBe(false);
      const snapshot = await runtime.snapshot();
      expect(snapshot.runState).toBe("conflict");
      expect(snapshot.active?.projectionConflict?.message).toMatch(
        /could not verify ownership/,
      );
      expect(snapshot.active?.projectionConflict?.kind).toBe("external-change");
      await runtime.abort("session-a");
      expect(
        workers[0]!.commands.some((command) => command.type === "abort"),
      ).toBe(false);
      expect(workers[0]!.stops).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("hard-stops and recovers a conflicted extension-blocked worker through abort", async () => {
    const { runtime, workers, path } = await setup();
    try {
      workers[0]!.emit("event", {
        type: "extension_ui_request",
        id: "blocked",
        method: "confirm",
        title: "Blocked",
      });
      await appendFile(
        path,
        `${JSON.stringify({
          type: "message",
          id: "external",
          parentId: "u1",
          timestamp: "2026-08-01T00:00:03.000Z",
          message: { role: "assistant", content: "external", timestamp: 3 },
        })}\n`,
      );
      await expect(
        runtime.extensionUiResponse({
          sessionId: "session-a",
          id: "blocked",
          confirmed: true,
        }),
      ).rejects.toThrow(/could not verify ownership/);
      expect((await runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);
      await runtime.abort("session-a");
      const recovered = await runtime.snapshot();
      expect(workers[0]!.stops).toBe(1);
      expect(recovered.runState).toBe("aborted");
      expect(recovered.pendingExtensionUiRequests).toEqual([]);
      expect(recovered.active?.projectionConflict).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it("serializes concurrent extension responses and sends only the winning response", async () => {
    const { runtime, workers } = await setup();
    try {
      workers[0]!.emit("event", {
        type: "extension_ui_request",
        id: "once",
        method: "confirm",
        title: "Once",
      });
      const responses = await Promise.allSettled([
        runtime.extensionUiResponse({
          sessionId: "session-a",
          id: "once",
          confirmed: true,
        }),
        runtime.extensionUiResponse({
          sessionId: "session-a",
          id: "once",
          confirmed: false,
        }),
      ]);
      expect(
        responses.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        responses.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(
        workers[0]!.commands.filter(
          (command) => command.type === "extension_ui_response",
        ),
      ).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("conflicts and stops a busy writer after an atomic same-content source replacement", async () => {
    const { runtime, workers, path } = await setup();
    try {
      await runtime.snapshot();
      const worker = workers[0]!;
      worker.emit("event", { type: "agent_start" });
      const bytes = await readFile(path);
      const replacement = `${path}.replacement`;
      await writeFile(replacement, bytes);
      await rename(replacement, path);
      await vi.waitFor(() => expect(worker.stops).toBe(1));
      expect((await runtime.snapshot()).runState).toBe("conflict");
    } finally {
      await runtime.close();
    }
  });

  it("retires an idle writer after an atomic same-content source replacement and starts fresh before writing", async () => {
    const { runtime, workers, path } = await setup();
    try {
      await runtime.snapshot();
      const first = workers[0]!;
      const bytes = await readFile(path);
      const replacement = `${path}.replacement`;
      await writeFile(replacement, bytes);
      await rename(replacement, path);
      await vi.waitFor(() => expect(first.stops).toBe(1));
      expect((await runtime.snapshot()).runState).not.toBe("conflict");
      await runtime.prompt({
        sessionId: "session-a",
        message: "fresh writer",
      });
      await vi.waitFor(() => expect(workers).toHaveLength(2));
      expect(workers[1]!.commands).toContainEqual({
        type: "prompt",
        message: "fresh writer",
      });
    } finally {
      await runtime.close();
    }
  });

  it.each([false, true])(
    "continues a fully verified same-object, same-byte rewrite (busy: %s) without acquiring another writer",
    async (busy) => {
      const { runtime, workers, path } = await setup();
      try {
        await runtime.snapshot();
        const worker = workers[0]!;
        if (busy) {
          worker.emit("event", { type: "agent_start" });
          await vi.waitFor(async () =>
            expect((await runtime.snapshot()).runState).toBe("running"),
          );
        }
        await writeFile(path, await readFile(path));
        const snapshot = await runtime.snapshot();
        expect(snapshot.active?.projectionConflict).toBeNull();
        expect(snapshot.runState).toBe(busy ? "running" : "idle");
        if (busy) {
          worker.emit("event", { type: "agent_settled" });
          await vi.waitFor(async () =>
            expect((await runtime.snapshot()).runState).toBe("idle"),
          );
        }
        await runtime.prompt({
          sessionId: "session-a",
          message: "continue same writer",
        });
        expect(worker.stops).toBe(0);
        expect(workers).toHaveLength(1);
        expect(worker.commands).toContainEqual({
          type: "prompt",
          message: "continue same writer",
        });
      } finally {
        await runtime.close();
      }
    },
  );

  it("accepts an ordinary exactly owned append without a source-version false conflict", async () => {
    const { runtime, workers, path } = await setup();
    try {
      await runtime.snapshot();
      const worker = workers[0]!;
      const live = { role: "assistant", content: "ordinary", timestamp: 2 };
      worker.emit("event", { type: "agent_start" });
      worker.emit("event", { type: "message_end", message: live });
      await appendFile(
        path,
        `${JSON.stringify({
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp: "2026-08-01T00:00:02.000Z",
          message: live,
        })}\n`,
      );
      await vi.waitFor(async () =>
        expect(
          (await runtime.snapshot()).active?.transcriptPage.messages.at(-1),
        ).toMatchObject({ content: "ordinary" }),
      );
      expect(worker.stops).toBe(0);
      expect((await runtime.snapshot()).active?.projectionConflict).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it("stops an idle active writer on an unknown partial append and refuses a later prompt", async () => {
    const { runtime, workers, path } = await setup();
    try {
      await runtime.snapshot();
      await vi.waitFor(() =>
        expect(
          workers[0]!.commands.some(
            (command) => command.type === "get_commands",
          ),
        ).toBe(true),
      );
      await appendFile(
        path,
        JSON.stringify({ type: "message", id: "a1", parentId: "u1" }).slice(
          0,
          -2,
        ),
      );
      await vi.waitFor(() => expect(workers[0]!.stops).toBe(1));
      await expect(
        runtime.prompt({
          sessionId: "session-a",
          message: "must not concatenate",
        }),
      ).rejects.toThrow(/incomplete|unowned|changed/i);
      expect((await runtime.snapshot()).runState).toBe("conflict");
    } finally {
      await runtime.close();
    }
  });

  it("refuses to start a writer for a pre-existing valid JSON object without its final LF", async () => {
    const validEntry = JSON.stringify({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-08-01T00:00:02.000Z",
      message: { role: "assistant", content: "not committed", timestamp: 2 },
    });
    const { runtime, workers } = await setup(
      [],
      undefined,
      true,
      validEntry,
      false,
    );
    try {
      await expect(
        runtime.prompt({
          sessionId: "session-a",
          message: "must not be concatenated",
        }),
      ).rejects.toThrow(/incomplete JSONL/i);
      expect(workers).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it("fails startup closed when a partial append appears before attestation", async () => {
    const { runtime, workers } = await setup([], (worker) => {
      worker.onStart = async () => {
        await appendFile(worker.sessionPath, '{"type":"message"');
      };
    });
    try {
      await vi.waitFor(() =>
        expect(workers[0]!.stops).toBeGreaterThanOrEqual(1),
      );
      expect((await runtime.snapshot()).runState).toBe("failed");
      expect(
        workers[0]!.commands.some((command) => command.type === "get_commands"),
      ).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("waits for an owned partial append and accepts only its exact completed entry", async () => {
    const { runtime, workers, path } = await setup();
    try {
      const worker = workers[0]!;
      await runtime.snapshot();
      await vi.waitFor(() =>
        expect(
          worker.commands.some((command) => command.type === "get_commands"),
        ).toBe(true),
      );
      const live = { role: "assistant", content: "owned", timestamp: 2 };
      const entry = JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:02.000Z",
        message: live,
      });
      worker.emit("event", { type: "agent_start" });
      worker.emit("event", { type: "message_end", message: live });
      await appendFile(path, entry.slice(0, -16));
      const slot = (
        runtime as unknown as {
          slots: Map<string, { projection: { uncommittedBytes: number } }>;
        }
      ).slots.get("session-a")!;
      await vi.waitFor(() =>
        expect(slot.projection.uncommittedBytes).toBeGreaterThan(0),
      );
      const firstChunkBytes = slot.projection.uncommittedBytes;
      await appendFile(path, entry.slice(-16, -8));
      await vi.waitFor(() =>
        expect(slot.projection.uncommittedBytes).toBeGreaterThan(
          firstChunkBytes,
        ),
      );
      expect(worker.stops).toBe(0);
      await appendFile(path, `${entry.slice(-8)}\n`);
      await vi.waitFor(async () => {
        expect(
          (await runtime.snapshot()).active?.transcriptPage.messages.at(-1),
        ).toMatchObject({ content: "owned" });
      });
      expect(worker.stops).toBe(0);
      worker.emit("event", { type: "agent_settled" });
    } finally {
      await runtime.close();
    }
  });

  it.each(["matching", "mismatching"] as const)(
    "holds an idle native Bash partial append for its %s final worker witness",
    async (witness) => {
      const partialWritten = deferredSignal();
      const completeWrite = deferredSignal();
      const result = {
        output: "owned shell output",
        exitCode: 0,
        cancelled: false,
        truncated: false,
      };
      const entry = {
        type: "message",
        id: "bash-1",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:02.000Z",
        message: {
          role: "bashExecution",
          command: "echo owned",
          ...result,
          timestamp: 2,
          excludeFromContext: false,
        },
      };
      const line = `${JSON.stringify(entry)}\n`;
      const firstCut = line.length - 32;
      const secondCut = line.length - 16;
      const { runtime, workers, path } = await setup([], (worker) => {
        worker.responseOverrides.set("bash", async () => {
          // Installed Pi persists direct Bash without message_end/entry_appended.
          // Hold physical write progress so reconciliation sees each exact prefix.
          worker.startupEntries = [
            witness === "matching"
              ? entry
              : {
                  ...entry,
                  message: { ...entry.message, output: "different" },
                },
          ];
          worker.startupLeafId = entry.id;
          await appendFile(worker.sessionPath, line.slice(0, firstCut));
          partialWritten.resolve();
          await completeWrite.promise;
          await appendFile(worker.sessionPath, line.slice(secondCut));
          return result;
        });
      });
      const internals = runtime as unknown as {
        slots: Map<string, RuntimeSlot>;
        reconcileSlot(slot: RuntimeSlot, force: boolean): Promise<unknown>;
      };
      let delivery: Promise<unknown> | undefined;
      try {
        await waitForReady(runtime, "session-a");
        const slot = internals.slots.get("session-a")!;
        const worker = workers[0]!;
        delivery = runtime.prompt({
          sessionId: "session-a",
          message: "!echo owned",
        });
        await partialWritten.promise;
        expect(slot.runState).toBe("idle");
        expect(slot.nativeBash?.worker).toBe(slot.process);
        expect(slot.persistenceExpectations).toEqual([]);
        await internals.reconcileSlot(slot, true);
        expect(slot.pendingPartialPersistence?.bytes).toBe(firstCut);
        expect(slot.conflict).toBeNull();
        expect(worker.stops).toBe(0);

        await appendFile(path, line.slice(firstCut, secondCut));
        await internals.reconcileSlot(slot, true);
        expect(slot.pendingPartialPersistence?.bytes).toBe(secondCut);
        expect(slot.workerProjectionSourceVersion).toBe(
          slot.projection!.sourceVersion,
        );
        expect(worker.stops).toBe(0);

        completeWrite.resolve();
        await delivery;
        await internals.reconcileSlot(slot, true);
        expect(worker.commands).toContainEqual({
          type: "get_entries",
          since: "u1",
        });
        expect(slot.pendingPartialPersistence).toBeNull();
        if (witness === "matching") {
          expect(slot.process).toBe(worker);
          expect(slot.conflict).toBeNull();
          expect(slot.runState).toBe("idle");
          expect(slot.workerProjectionRevision).toBe(slot.projection!.revision);
          expect(slot.projection!.messages.at(-1)).toMatchObject(entry.message);
          expect(worker.stops).toBe(0);
        } else {
          expect(slot.conflict?.kind).toBe("incomplete-persistence");
          expect(slot.runState).toBe("conflict");
          expect(slot.process).toBeNull();
          expect(slot.ready).toBe(false);
          expect(worker.stops).toBe(1);
        }
      } finally {
        completeWrite.resolve();
        await delivery?.catch(() => {});
        await runtime.close();
      }
    },
  );

  it.each(["in-place", "atomic"] as const)(
    "rejects an owned partial tail followed by a same-byte %s rewrite",
    async (mode) => {
      const { runtime, workers, path } = await setup();
      try {
        const worker = workers[0]!;
        await runtime.snapshot();
        worker.emit("event", { type: "agent_start" });
        await appendFile(path, "owned-partial-same-bytes");
        const slot = (
          runtime as unknown as {
            slots: Map<string, { projection: { uncommittedBytes: number } }>;
          }
        ).slots.get("session-a")!;
        await vi.waitFor(() =>
          expect(slot.projection.uncommittedBytes).toBeGreaterThan(0),
        );
        const bytes = await readFile(path);
        if (mode === "in-place") {
          await writeFile(path, bytes);
        } else {
          const replacement = `${path}.replacement`;
          await writeFile(replacement, bytes);
          await rename(replacement, path);
        }
        await vi.waitFor(() => expect(worker.stops).toBe(1));
        expect((await runtime.snapshot()).runState).toBe("conflict");
      } finally {
        await runtime.close();
      }
    },
  );

  it.each(["truncate", "rewrite"] as const)(
    "fails an owned partial append closed when its tail is %s",
    async (mode) => {
      const { runtime, workers, path } = await setup();
      try {
        const worker = workers[0]!;
        await runtime.snapshot();
        worker.emit("event", { type: "agent_start" });
        const slot = (
          runtime as unknown as {
            slots: Map<
              string,
              {
                projection: {
                  committedBytes: number;
                  uncommittedBytes: number;
                };
              }
            >;
          }
        ).slots.get("session-a")!;
        const committed = slot.projection.committedBytes;
        await appendFile(path, "partial-owned-tail");
        await vi.waitFor(() =>
          expect(slot.projection.uncommittedBytes).toBeGreaterThan(0),
        );
        if (mode === "truncate") {
          await truncate(path, committed);
        } else {
          const prefix = (await readFile(path)).subarray(0, committed);
          await writeFile(
            path,
            Buffer.concat([prefix, Buffer.from("different-owned-tail")]),
          );
        }
        await vi.waitFor(() => expect(worker.stops).toBe(1));
        expect((await runtime.snapshot()).runState).toBe("conflict");
      } finally {
        await runtime.close();
      }
    },
  );

  it.each([
    {
      command: "prompt",
      invoke: (runtime: RuntimeController) =>
        runtime.prompt({ sessionId: "session-a", message: "late prompt" }),
      entry: {
        type: "message",
        id: "late",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:03.000Z",
        message: { role: "user", content: "late prompt", timestamp: 3 },
      },
    },
    {
      command: "compact",
      invoke: (runtime: RuntimeController) =>
        runtime.prompt({ sessionId: "session-a", message: "/compact" }),
      entry: {
        type: "compaction",
        id: "late",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:03.000Z",
        summary: "late",
        firstKeptEntryId: "u1",
        tokensBefore: 10,
      },
    },
    {
      command: "set_session_name",
      invoke: (runtime: RuntimeController) =>
        runtime.rename("session-a", "late name"),
      entry: {
        type: "session_info",
        id: "late",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:03.000Z",
        name: "late name",
      },
    },
    {
      command: "set_model",
      invoke: (runtime: RuntimeController) =>
        runtime.setModel("session-a", "provider", "model"),
      entry: {
        type: "model_change",
        id: "late",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:03.000Z",
        provider: "provider",
        modelId: "model",
      },
    },
    {
      command: "set_thinking_level",
      invoke: (runtime: RuntimeController) =>
        runtime.setThinkingLevel("session-a", "high"),
      entry: {
        type: "thinking_level_change",
        id: "late",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:03.000Z",
        thinkingLevel: "high",
      },
    },
  ])(
    "hard-stops and reconciles a late $command persistence after acceptance becomes unknown",
    async ({ command, invoke, entry }) => {
      const { runtime, workers, path } = await setup();
      try {
        const worker = workers[0]!;
        const original = worker.request.bind(worker);
        worker.request = async <T>(request: Record<string, unknown>) => {
          if (request.type !== command) return original<T>(request);
          worker.commands.push(request);
          await appendFile(path, `${JSON.stringify(entry)}\n`);
          const error = new PiRpcOutcomeUnknownError(command);
          error.stopped = Promise.resolve();
          throw error;
        };
        await expect(invoke(runtime)).rejects.toMatchObject({
          status: 504,
          code: "PI_RPC_OUTCOME_UNKNOWN",
          outcomeUnknown: true,
        });
        expect(worker.stops).toBe(1);
        const snapshot = await runtime.snapshot();
        expect(snapshot.runState).toBe("conflict");
        expect(snapshot.active).toMatchObject({
          durableLeafId: entry.id,
          projectionConflict: { kind: "outcome-unknown" },
        });
        const slot = (
          runtime as unknown as { slots: Map<string, RuntimeSlot> }
        ).slots.get("session-a")!;
        // Reconciliation must retain the exact late disk entry for every
        // mutation family, including metadata entries with no transcript row.
        expect(slot.projection!.entriesAfter("u1")).toEqual([entry]);
        if (command === "prompt")
          expect(snapshot.active?.transcriptPage.messages).toContainEqual(
            expect.objectContaining({
              role: "user",
              content: "late prompt",
            }),
          );
        const dispatched = worker.commands.length;
        await expect(
          runtime.rename("session-a", "must not dispatch"),
        ).rejects.toThrow(/outcome is unknown/);
        expect(worker.commands).toHaveLength(dispatched);
      } finally {
        await runtime.close();
      }
    },
  );

  it("close cancels an active mutation and drains queued event/projection tails", async () => {
    const { runtime, workers } = await setup();
    const worker = workers[0]!;
    const original = worker.request.bind(worker);
    let mutationStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      mutationStarted = resolveStarted;
    });
    worker.request = async <T>(command: Record<string, unknown>) => {
      if (command.type !== "set_session_name") return original<T>(command);
      mutationStarted();
      return new Promise<T>((_resolve, reject) => {
        worker.onStop = () => reject(new Error("worker stopped"));
      });
    };
    const mutation = runtime.rename("session-a", "closing");
    const mutationRejected = expect(mutation).rejects.toThrow(/worker stopped/);
    await started;
    workers[0]!.emit("event", { type: "agent_settled" });
    await expect(runtime.close()).resolves.toBeUndefined();
    await mutationRejected;
    expect(worker.stops).toBe(1);
  });
});
