import {
  appendFile,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type DiagnosticLogger,
  nullDiagnosticLogger,
} from "../../server/diagnostics.js";
import { PiRpcOutcomeUnknownError } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import { deferredSignal, waitForReady } from "./fixtures/runtime.js";
import {
  disposeProjectionFixture,
  runtimeProjection,
  setup,
} from "./fixtures/runtime-projection.js";
import { jsonl, messageEntry } from "./fixtures/session-jsonl.js";

afterEach(disposeProjectionFixture);

/** Another program replaces the session file instead of appending to it. */
async function replaceWith(path: string, extra: string): Promise<void> {
  const next = `${path}.replacement`;
  await writeFile(next, (await readFile(path, "utf8")) + extra);
  await rename(next, path);
}

describe("writer persistence ownership", () => {
  it.each([
    { role: "user", completion: "before" },
    { role: "user", completion: "after" },
    { role: "assistant", completion: "before" },
    { role: "toolResult", completion: "after" },
  ] as const)(
    "reconciles $role completion $completion a worker-witnessed mixed append",
    async ({ role, completion }) => {
      const { runtime, workers, path } = await setup();
      await waitForReady(runtime, "session-a");
      const worker = workers[0]!;
      const { slot, reconcile } = runtimeProjection(runtime);
      const message = {
        role,
        content: [{ type: "text", text: "A verified message" }],
        timestamp: role === "user" ? 1 : 2,
        ...(role === "assistant" ? { stopReason: "stop" } : {}),
        ...(role === "toolResult"
          ? { toolCallId: "read-1", toolName: "read", isError: false }
          : {}),
      };
      const toolCall = {
        type: "message",
        id: "assistant-tool",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:02.000Z",
        message: {
          role: "assistant",
          timestamp: 3,
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "read-1",
              name: "read",
              arguments: { path: "input.txt" },
            },
          ],
        },
      };
      const metadata = {
        type: "custom",
        id: "interleaved-metadata",
        parentId: role === "toolResult" ? toolCall.id : "u1",
        timestamp: "2026-08-01T00:00:02.500Z",
        customType: "tool-discovery",
        data: {
          loaded: true,
          ...(role === "toolResult" ? { text: "x".repeat(150_000) } : {}),
        },
      };
      const entry = messageEntry(
        "verified-message",
        metadata.id,
        message,
        "2026-08-01T00:00:03.000Z",
      );
      worker.emit("event", { type: "agent_start" });
      if (role === "toolResult") {
        worker.emit("event", {
          type: "message_end",
          message: toolCall.message,
        });
        worker.emit("event", { type: "entry_appended", entry: metadata });
      }
      worker.emit("event", { type: "message_start", message });
      if (completion === "before")
        worker.emit("event", { type: "message_end", message });
      if (role === "user") {
        await vi.waitFor(async () => {
          expect(
            (await runtime.snapshot("session-a")).active!.transcriptPage
              .messages,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ content: "original" }),
              expect.objectContaining({ content: message.content }),
            ]),
          );
        });
      }

      // Reconcile both event orders with an exact get_entries witness.
      const entries =
        role === "toolResult" ? [toolCall, metadata, entry] : [metadata, entry];
      worker.startupEntries = entries;
      worker.startupLeafId = entry.id;
      await appendFile(path, jsonl(...entries));
      await reconcile();
      if (completion === "after")
        worker.emit("event", { type: "message_end", message });

      await vi.waitFor(() => expect(slot.overlay).toEqual([]));
      expect(slot.persistenceExpectations).toEqual([]);
      const first = await runtime.snapshot("session-a");
      const messages = first.active!.transcriptPage.messages as Array<
        Record<string, unknown>
      >;
      expect(
        messages.filter((item) => item.timestamp === message.timestamp),
      ).toEqual([
        ...(role === "user"
          ? [
              expect.objectContaining({
                content: "original",
                __inspireEntryId: "u1",
              }),
            ]
          : []),
        expect.objectContaining({
          role,
          __inspireEntryId: entry.id,
          __inspireMessageId: `${entry.id}:0`,
        }),
      ]);

      const later = messageEntry(
        "later-input",
        entry.id,
        {
          role: "user",
          content: "Next input",
          timestamp: 4,
        },
        "2026-08-01T00:00:04.000Z",
      );
      worker.startupEntries = [later];
      worker.startupLeafId = later.id;
      worker.emit("event", {
        type: "message_start",
        message: later.message,
      });
      worker.emit("event", {
        type: "message_end",
        message: later.message,
      });
      await appendFile(path, jsonl(later));
      await reconcile();

      const next = await runtime.snapshot("session-a");
      expect(next.active!.transcriptPage.messages.at(-1)).toMatchObject({
        ...later.message,
        __inspireEntryId: later.id,
      });
      expect(slot.overlay).toEqual([]);
      expect(slot.persistenceExpectations).toEqual([]);
      expect(slot.conflict).toBeNull();
      expect(worker.stops).toBe(0);
    },
  );

  it.each(["before", "after"] as const)(
    "binds completion persisted %s presentation delayed by lifecycle reconciliation",
    async (persisted) => {
      const { runtime, workers, path } = await setup();
      const gate = deferredSignal();
      try {
        await waitForReady(runtime, "session-a");
        const worker = workers[0]!;
        const { slot, reconcile } = runtimeProjection(runtime);
        slot.eventTail = gate.promise;
        worker.emit("event", { type: "compaction_end", reason: "auto" });
        const entry = messageEntry(
          "after-compaction",
          "u1",
          {
            role: "user",
            content: "Continue after compaction",
            timestamp: 3,
          },
          "2026-08-01T00:00:03.000Z",
        );
        worker.startupEntries = [entry];
        worker.startupLeafId = entry.id;
        worker.emit("event", { type: "message_start", message: entry.message });
        worker.emit("event", { type: "message_end", message: entry.message });
        if (persisted === "before") await appendFile(path, jsonl(entry));
        gate.resolve();
        await slot.eventTail;
        if (persisted === "after") {
          await appendFile(path, jsonl(entry));
          await reconcile();
        }
        const messages = (await runtime.snapshot("session-a")).active!
          .transcriptPage.messages;
        expect(
          messages.filter(
            (message) =>
              (message as { content?: unknown }).content ===
              entry.message.content,
          ),
        ).toEqual([expect.objectContaining({ __inspireEntryId: entry.id })]);
        expect(slot.overlay).toEqual([]);
        expect(slot.persistenceExpectations).toEqual([]);
        expect(slot.conflict).toBeNull();
      } finally {
        gate.resolve();
        await runtime.close();
      }
    },
  );

  it("queues concurrent mutations until the stale writer retires, then uses one replacement", async () => {
    const { runtime, workers, path } = await setup();
    const retirement = deferredSignal();
    const stopping = deferredSignal();
    const stop = vi.spyOn(workers[0]!, "stop").mockImplementation(() => {
      stopping.resolve();
      return retirement.promise;
    });
    try {
      await waitForReady(runtime, "session-a");
      await replaceWith(
        path,
        `${JSON.stringify({
          type: "message",
          id: "external",
          parentId: "u1",
          timestamp: "2026-08-01T00:00:02.000Z",
          message: { role: "assistant", content: "terminal", timestamp: 2 },
        })}\n`,
      );
      const accepted = expect(
        Promise.all([
          runtime.rename("session-a", "first"),
          runtime.setThinkingLevel("session-a", "high"),
        ]),
      ).resolves.toHaveLength(2);
      await stopping.promise;
      // Stopping is asynchronous. The next writer and its work must wait for exit.
      await new Promise<void>((tick) => setImmediate(tick));
      expect(workers).toHaveLength(1);
      const writes = (commands: Record<string, unknown>[]) =>
        commands
          .map((command) => command.type)
          .filter(
            (type) =>
              type === "set_session_name" || type === "set_thinking_level",
          );
      expect(writes(workers[0]!.commands)).toEqual([]);

      retirement.resolve();
      await accepted;
      expect(stop).toHaveBeenCalledOnce();
      expect(workers).toHaveLength(2);
      expect(writes(workers[1]!.commands)).toEqual([
        "set_session_name",
        "set_thinking_level",
      ]);
    } finally {
      retirement.resolve();
      await runtime.close();
    }
  });

  it("refreshes stale writers for model and compact control families", async () => {
    const { runtime, workers, path } = await setup();
    await replaceWith(
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

    await replaceWith(
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
  });

  it("verifies an owned compaction revision before accepting another Pi's revision queued behind it", async () => {
    const { runtime, workers, path } = await setup();
    const gate = deferredSignal();
    const started = deferredSignal();
    const { slot, ownership } = runtimeProjection(runtime);
    const projection = slot.projection!;
    const checks = vi.spyOn(ownership, "appendedEntriesOwnership");
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
      // The later entry is another Pi continuing the session: valid.
      expect((await runtime.snapshot()).runState).not.toBe("conflict");
    } finally {
      gate.resolve();
      await runtime.close();
    }
  });

  it("preserves both an owned metadata write and an external append in the same observation", async () => {
    const { runtime, workers, path } = await setup();
    await waitForReady(runtime, "session-a");
    const worker = workers[0]!;
    const own = {
      type: "session_info",
      id: "own-name",
      parentId: "u1",
      timestamp: "2026-08-01T00:00:02.000Z",
      name: "owned",
    };
    const external = {
      type: "session_info",
      id: "external-name",
      parentId: own.id,
      timestamp: "2026-08-01T00:00:03.000Z",
      name: "external",
    };
    const message = {
      type: "message",
      id: "external-message",
      parentId: external.id,
      timestamp: "2026-08-01T00:00:04.000Z",
      message: {
        role: "assistant",
        content: "external continuation",
        timestamp: 4,
      },
    };
    worker.responseOverrides.set("set_session_name", async () => {
      await appendFile(path, jsonl(own, external, message));
      return {};
    });

    await runtime.rename("session-a", "owned");
    const active = (await runtime.snapshot()).active;
    expect(active?.projectionConflict).toBeNull();
    expect(active?.durableLeafId).toBe(message.id);
    const history = await runtime.branchEntry({
      sessionId: "session-a",
      targetId: message.id,
      viewId: active!.transcriptPage.viewId,
    });
    expect(history.text).toContain(message.message.content);
    expect(worker.stops).toBe(0);
  });

  it("attests system and cache-usage entries without adding them to the browser transcript", async () => {
    const { runtime, workers, path } = await setup();
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) => events.push(event));
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
    await appendFile(path, jsonl(system, usage));
    await expect(
      runtime.rename("session-a", "after Pi metadata"),
    ).resolves.toBeUndefined();
    const snapshot = await runtime.snapshot();
    expect(snapshot.active?.projectionConflict).toBeNull();
    expect(snapshot.active?.transcriptPage.messages).toHaveLength(1);
    expect(worker.stops).toBe(0);
  });

  it("accepts an exact observed prefix when the same worker advances during witness lookup", async () => {
    const record = vi.fn<DiagnosticLogger["record"]>();
    const { runtime, workers, path } = await setup(
      [],
      undefined,
      true,
      "",
      true,
      { ...nullDiagnosticLogger(), record },
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
      const witnessStarted = deferredSignal();
      const witnessGate = deferredSignal();
      releaseWitness = witnessGate.resolve;
      const originalRequest = worker.request.bind(worker);
      worker.request = async <T>(
        command: Record<string, unknown>,
      ): Promise<T> => {
        if (command.type !== "get_entries") return originalRequest<T>(command);
        witnessStarted.resolve();
        await witnessGate.promise;
        return originalRequest<T>(command);
      };

      const getEntriesBefore = worker.commands.filter(
        (command) => command.type === "get_entries",
      ).length;
      worker.emit("event", { type: "agent_start" });
      worker.startupEntries = [observed];
      worker.startupLeafId = observed.id;
      await appendFile(path, jsonl(observed));

      const reconciling = runtime.rename(
        "session-a",
        "during worker advancement",
      );
      await witnessStarted.promise;

      worker.startupEntries = [observed, trailing];
      worker.startupLeafId = trailing.id;
      await appendFile(path, jsonl(trailing));
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
      const witnessed = record.mock.calls.find(
        ([, event, fields]) =>
          event === "persistence_ownership_decision" &&
          fields?.owned === true &&
          fields.workerWitness !== undefined,
      );
      expect(witnessed?.[2]?.workerWitness).toEqual({
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

  it("treats the same entry ID with different contents as another Pi's append", async () => {
    const record = vi.fn<DiagnosticLogger["record"]>();
    const { runtime, workers, path } = await setup(
      [],
      undefined,
      true,
      "",
      true,
      { ...nullDiagnosticLogger(), record },
    );
    const worker = workers[0]!;
    const external = {
      type: "custom",
      id: "external-custom",
      parentId: "u1",
      timestamp: "2026-08-01T00:00:02.000Z",
      customType: "web-search-results",
      data: { external: true },
    };
    worker.startupEntries = [{ ...external, data: { external: false } }];
    worker.startupLeafId = external.id;
    worker.emit("event", { type: "agent_start" });
    await appendFile(path, jsonl(external));

    await runtime.rename("session-a", "still writes");
    expect(
      (await runtime.snapshot()).active?.projectionConflict ?? null,
    ).toBeNull();
    const decision = record.mock.calls.find(
      ([, event, fields]) =>
        event === "persistence_ownership_decision" && fields?.owned === false,
    );
    expect(decision?.[2]).toMatchObject({
      ownershipRejection: "worker-entry-mismatch",
      workerWitness: {
        observedEntries: 1,
        workerEntries: 1,
        aheadBy: 0,
        observedLeafId: "external-custom",
        workerLeafId: external.id,
      },
    });
    expect(
      record.mock.calls.some(([, event]) => event === "projection_conflict"),
    ).toBe(false);
    expect(JSON.stringify(record.mock.calls)).not.toContain('"external":true');
    expect(worker.stops).toBe(0);
  });

  it.each(["rename", "extension reply"] as const)(
    "detects a busy history rewrite before dispatching a %s and recovers through Stop",
    async (operation) => {
      const { runtime, workers, path } = await setup();
      await waitForReady(runtime, "session-a");
      const worker = workers[0]!;
      worker.emit("event", { type: "agent_start" });
      if (operation === "extension reply")
        worker.emit("event", {
          type: "extension_ui_request",
          id: "blocked",
          method: "confirm",
          title: "Blocked",
        });
      const bytes = await readFile(path, "utf8");
      await writeFile(
        path,
        bytes.replace('"content":"original"', '"content":"rewritten"'),
      );
      const mutation =
        operation === "rename"
          ? runtime.rename("session-a", "must not write")
          : runtime.extensionUiResponse({
              sessionId: "session-a",
              id: "blocked",
              confirmed: true,
            });
      await expect(mutation).rejects.toThrow(/could not verify/);
      expect(await runtime.snapshot()).toMatchObject({
        runState: "conflict",
        active: {
          projectionConflict: {
            kind: "external-change",
            message: expect.stringMatching(/could not verify/),
          },
        },
        pendingExtensionUiRequests: [],
      });

      await runtime.abort("session-a");
      for (const type of ["set_session_name", "extension_ui_response", "abort"])
        expect(worker.commands).not.toContainEqual(
          expect.objectContaining({ type }),
        );
      expect(worker.stops).toBe(1);
      expect(await runtime.snapshot()).toMatchObject({
        runState: "aborted",
        active: { projectionConflict: null },
        pendingExtensionUiRequests: [],
      });
    },
  );

  it.each(["replaced", "removed"] as const)(
    "keeps a writer from sending a prompt after its source is %s",
    async (change) => {
      const { runtime, workers, path } = await setup();
      await runtime.snapshot();
      const first = workers[0]!;
      if (change === "removed") await rm(path);
      else await replaceWith(path, "");
      const prompt = { sessionId: "session-a", message: "fresh writer" };
      if (change === "removed") {
        await expect(runtime.prompt(prompt)).rejects.toMatchObject({
          status: 409,
        });
        expect(workers).toHaveLength(1);
      } else {
        await vi.waitFor(() => expect(first.stops).toBe(1));
        expect((await runtime.snapshot()).runState).not.toBe("conflict");
        await runtime.prompt(prompt);
        expect(workers).toHaveLength(2);
        expect(workers[1]!.commands).toContainEqual({
          type: "prompt",
          message: prompt.message,
        });
      }
      expect(first.commands).not.toContainEqual({
        type: "prompt",
        message: prompt.message,
      });
    },
  );

  it("accepts a same-file rewrite and an exact owned append, then stops on inode replacement", async () => {
    const { runtime, workers, path } = await setup();
    await waitForReady(runtime, "session-a");
    const worker = workers[0]!;
    worker.emit("event", { type: "agent_start" });
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).runState).toBe("running"),
    );
    await writeFile(path, await readFile(path));
    expect(await runtime.snapshot()).toMatchObject({
      runState: "running",
      active: { projectionConflict: null },
    });

    const message = {
      role: "assistant",
      content: "owned reply",
      timestamp: 2,
    };
    worker.emit("event", { type: "message_end", message });
    await appendFile(
      path,
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-08-01T00:00:02.000Z",
        message,
      }) + "\n",
    );
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).active).toMatchObject({
        durableLeafId: "a1",
        projectionConflict: null,
        transcriptPage: {
          messages: expect.arrayContaining([
            expect.objectContaining({ ...message, __inspireEntryId: "a1" }),
          ]),
        },
      }),
    );

    worker.emit("event", { type: "agent_settled" });
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).runState).toBe("idle"),
    );
    await runtime.prompt({
      sessionId: "session-a",
      message: "continue same writer",
    });
    expect(workers).toHaveLength(1);
    expect(worker.stops).toBe(0);
    expect(worker.commands).toContainEqual({
      type: "prompt",
      message: "continue same writer",
    });

    worker.emit("event", { type: "agent_start" });
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).runState).toBe("running"),
    );
    await replaceWith(path, "");
    await vi.waitFor(() => expect(worker.stops).toBe(1));
    expect(await runtime.snapshot()).toMatchObject({
      runState: "conflict",
      active: { projectionConflict: { kind: "external-change" } },
    });
  });

  it("refuses to write after another Pi's incomplete line", async () => {
    const { runtime, workers, path } = await setup();
    await waitForReady(runtime, "session-a");
    await appendFile(
      path,
      JSON.stringify({ type: "message", id: "a1", parentId: "u1" }).slice(
        0,
        -2,
      ),
    );
    // Another Pi may still be writing: no conflict yet, but nothing may be
    // appended after an incomplete line.
    await expect(
      runtime.prompt({
        sessionId: "session-a",
        message: "must not concatenate",
      }),
    ).rejects.toThrow(/incomplete|unowned|changed/i);
    expect(
      workers
        .flatMap((worker) => worker.commands)
        .some((command) => command.type === "prompt"),
    ).toBe(false);
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
    await expect(
      runtime.prompt({
        sessionId: "session-a",
        message: "must not be concatenated",
      }),
    ).rejects.toThrow(/incomplete JSONL/i);
    expect(workers).toHaveLength(0);
  });

  it("waits for an owned partial append and accepts only its exact completed entry", async () => {
    const { runtime, workers, path } = await setup();
    const worker = workers[0]!;
    await waitForReady(runtime, "session-a");
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
    const { slot, reconcile } = runtimeProjection(runtime);
    const projection = slot.projection!;
    await vi.waitFor(() =>
      expect(projection.uncommittedBytes).toBeGreaterThan(0),
    );
    const firstChunkBytes = projection.uncommittedBytes;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      await reconcile();
      expect(projection.health.status).toBe("pending");
      expect(projection.leafId).toBe("u1");
      expect(slot.process).toBe(worker);
      expect(slot.conflict).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    await appendFile(path, entry.slice(-16, -8));
    await vi.waitFor(() =>
      expect(projection.uncommittedBytes).toBeGreaterThan(firstChunkBytes),
    );
    expect(worker.stops).toBe(0);
    await appendFile(path, `${entry.slice(-8)}\n`);
    await vi.waitFor(async () => {
      expect(
        (await runtime.snapshot()).active?.transcriptPage.messages.at(-1),
      ).toMatchObject({ content: "owned", __inspireEntryId: "a1" });
    });
    expect(slot.pendingPartialPersistence).toBeNull();
    expect(projection.health.status).toBe("ok");
    expect(worker.stops).toBe(0);
    worker.emit("event", { type: "agent_settled" });
  });

  it("keeps an idle native Bash writer through partial appends until its final witness", async () => {
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
    const line = jsonl(entry);
    const firstCut = line.length - 32;
    const secondCut = line.length - 16;
    const { runtime, workers, path } = await setup([], (worker) => {
      worker.responseOverrides.set("bash", async () => {
        // Installed Pi persists direct Bash without message_end/entry_appended.
        // Hold physical write progress so reconciliation sees each exact prefix.
        worker.startupEntries = [entry];
        worker.startupLeafId = entry.id;
        await appendFile(worker.sessionPath, line.slice(0, firstCut));
        partialWritten.resolve();
        await completeWrite.promise;
        await appendFile(worker.sessionPath, line.slice(secondCut));
        return result;
      });
    });
    const { slot, reconcile } = runtimeProjection(runtime);
    let delivery: Promise<unknown> | undefined;
    try {
      await waitForReady(runtime, "session-a");
      const worker = workers[0]!;
      delivery = runtime.prompt({
        sessionId: "session-a",
        message: "!echo owned",
      });
      await partialWritten.promise;
      expect(slot.runState).toBe("idle");
      await reconcile();
      expect(slot.pendingPartialPersistence?.bytes).toBe(firstCut);
      expect(slot.conflict).toBeNull();
      expect(worker.stops).toBe(0);

      await appendFile(path, line.slice(firstCut, secondCut));
      await reconcile();
      expect(slot.pendingPartialPersistence?.bytes).toBe(secondCut);
      expect(slot.writerBaseline.sourceVersion).toBe(
        slot.projection!.sourceVersion,
      );
      expect(worker.stops).toBe(0);

      completeWrite.resolve();
      await delivery;
      await reconcile();
      expect(worker.commands).toContainEqual({
        type: "get_entries",
        since: "u1",
      });
      expect(slot.pendingPartialPersistence).toBeNull();
      expect(await runtime.snapshot()).toMatchObject({
        runState: "idle",
        active: { durableLeafId: entry.id, projectionConflict: null },
      });
      expect(worker.stops).toBe(0);
    } finally {
      completeWrite.resolve();
      await delivery?.catch(() => {});
      await runtime.close();
    }
  });

  it.each(["new timestamp", "new inode", "truncate", "new tail"] as const)(
    "retires the writer when an owned incomplete tail changes: %s",
    async (change) => {
      const { runtime, workers, path } = await setup();
      await waitForReady(runtime, "session-a");
      const worker = workers[0]!;
      const prefix = await readFile(path);
      worker.emit("event", { type: "agent_start" });
      await appendFile(path, "partial-owned-tail");
      const { slot } = runtimeProjection(runtime);
      await vi.waitFor(() =>
        expect(slot.pendingPartialPersistence).not.toBeNull(),
      );

      if (change === "new timestamp") {
        const details = await stat(path);
        await utimes(path, details.atime, new Date(details.mtimeMs + 5000));
      }
      if (change === "new inode") await replaceWith(path, "");
      if (change === "truncate") await truncate(path, prefix.length);
      if (change === "new tail")
        await writeFile(
          path,
          Buffer.concat([prefix, Buffer.from("different-owned-tail")]),
        );
      await vi.waitFor(() => expect(worker.stops).toBe(1));
      expect(await runtime.snapshot()).toMatchObject({
        runState: "conflict",
        active: { projectionConflict: { kind: "incomplete-persistence" } },
      });
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
  ])(
    "hard-stops and reconciles a late $command persistence after acceptance becomes unknown",
    async ({ command, invoke, entry }) => {
      const { runtime, workers, path } = await setup();
      const worker = workers[0]!;
      const original = worker.request.bind(worker);
      worker.request = async <T>(request: Record<string, unknown>) => {
        if (request.type !== command) return original<T>(request);
        worker.commands.push(request);
        await appendFile(path, jsonl(entry));
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
      const { slot } = runtimeProjection(runtime);
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
