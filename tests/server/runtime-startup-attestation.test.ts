import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSlot } from "../../server/runtime-slot.js";
import { deferredSignal } from "./fixtures/runtime.js";
import { jsonl, messageEntry } from "./fixtures/session-jsonl.js";

import {
  disposeProjectionFixture,
  setup,
} from "./fixtures/runtime-projection.js";

afterEach(disposeProjectionFixture);

describe("writer startup attestation", () => {
  const startupThinking = (parentId: string | null) => ({
    type: "thinking_level_change",
    id: "startup1",
    parentId,
    timestamp: "2026-08-01T00:00:02.000Z",
    thinkingLevel: "off",
  });
  it.each([null, "u1"])(
    "uses the worker branch for startup from baseline %s",
    async (parentId) => {
      const entry = startupThinking(parentId);
      const sibling = messageEntry("external", parentId, {
        role: "assistant",
        content: "external",
        timestamp: 3,
      });
      const { runtime, workers, startup } = await setup(
        [],
        (worker) => {
          worker.startupEntries = [entry];
          worker.startupLeafId = entry.id;
          worker.onStart = async () => {
            await appendFile(
              worker.sessionPath,
              parentId === null ? jsonl(entry) : jsonl(entry, sibling),
            );
          };
        },
        parentId !== null,
      );
      await startup;
      expect(workers[0]!.stops).toBe(0);
      expect((await runtime.snapshot("session-a")).active).toMatchObject({
        thinkingLevel: "off",
        effectiveLeafId: entry.id,
        durableLeafId: parentId === null ? entry.id : sibling.id,
      });
    },
  );

  it.each(["exit", "unavailable"] as const)(
    "does not publish readiness after worker loss (%s) during final disk attestation",
    async (loss) => {
      const start = deferredSignal();
      const reconcileEntered = deferredSignal();
      const finishReconcile = deferredSignal();
      const retirement = deferredSignal();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { runtime, workers, startup } = await setup([], (worker) => {
        worker.onStart = () => start.promise;
      });
      const internals = runtime as unknown as {
        slots: Map<string, RuntimeSlot>;
      };
      const slot = internals.slots.get("session-a")!;
      const projection = slot.projection!;
      const reconcile = projection.reconcileSuspended.bind(projection);
      const heldReconcile = vi
        .spyOn(projection, "reconcileSuspended")
        .mockImplementation(async (force) => {
          reconcileEntered.resolve();
          await finishReconcile.promise;
          return reconcile(force);
        });
      const stop = vi
        .spyOn(workers[0]!, "stop")
        .mockImplementation(() => retirement.promise);
      const events: Array<{ type: string }> = [];
      runtime.on("event", (event) => events.push(event));
      const starting = startup!;
      const outcome = starting.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        start.resolve();
        await reconcileEntered.promise;
        if (loss === "exit") {
          workers[0]!.emit("exit", new Error("Synthetic attestation exit"));
          expect(slot.process).toBeNull();
          expect(slot.runState).toBe("failed");
        } else {
          vi.spyOn(workers[0]!, "available", "get").mockReturnValue(false);
        }
        finishReconcile.resolve();
        await vi.waitFor(() => expect(stop).toHaveBeenCalled());
        // Reconciliation cannot revive admission while actual stop is pending.
        expect(slot.ready).toBe(false);
        expect(slot.stopping).not.toBeNull();
        expect(slot.workerView).toBeNull();
        expect(events.some((event) => event.type === "runtime_ready")).toBe(
          false,
        );
        retirement.resolve();
        expect(await outcome).toMatchObject({ status: 503 });
        expect(slot.ready).toBe(false);
        expect(slot.startupPhase).toBe("idle");
        expect(slot.runState).toBe("failed");
        expect(slot.workerView).toBeNull();
        expect(events.some((event) => event.type === "runtime_ready")).toBe(
          false,
        );
      } finally {
        start.resolve();
        finishReconcile.resolve();
        retirement.resolve();
        await starting.catch(() => {});
        heldReconcile.mockRestore();
        await runtime.close();
        errors.mockRestore();
      }
    },
  );

  it.each([
    ["factory rewrite", false],
    ["factory append", false],
    ["partial append", true],
    ["bad parent", true],
    ["startup rewrite", true],
  ] as const)("fences writer admission after a %s", async (fault, starts) => {
    const entry = startupThinking(fault === "bad parent" ? "not-u1" : "u1");
    const { runtime, workers, sequence, opened } = await setup([], (worker) => {
      if (fault === "factory rewrite") {
        const original = readFileSync(worker.sessionPath, "utf8");
        writeFileSync(
          worker.sessionPath,
          original.replace(
            '"content":"original"',
            '"content":"replaced before startup"',
          ),
        );
        return;
      }
      if (fault === "partial append") {
        worker.onStart = () =>
          appendFile(worker.sessionPath, '{"type":"message"');
        return;
      }

      worker.startupEntries = [entry];
      worker.startupLeafId = entry.id;
      if (fault === "factory append") {
        appendFileSync(worker.sessionPath, jsonl(entry));
        return;
      }

      worker.onStart = async () => {
        const path = worker.sessionPath;
        if (fault === "startup rewrite") {
          const original = await readFile(path, "utf8");
          await writeFile(
            path,
            original.replace('"content":"original"', '"content":"rewritten"') +
              jsonl(entry),
          );
        } else await appendFile(path, jsonl(entry));
      };
    });

    await vi.waitFor(() => expect(workers[0]!.stops).toBe(1));
    expect(workers).toHaveLength(1);
    expect(sequence.includes("start")).toBe(starts);
    if (!starts) expect(workers[0]!.commands).toEqual([]);
    const snapshot = await runtime.snapshot("session-a");
    expect(snapshot.sessionStatuses["session-a"]?.runState).toBe("failed");
    if (fault === "factory rewrite") {
      const changed = snapshot.active!.transcriptPage;
      expect(changed.viewId).not.toBe(opened.active!.transcriptPage.viewId);
      expect(JSON.stringify(changed.messages)).toContain(
        "replaced before startup",
      );
    }
  });
});
