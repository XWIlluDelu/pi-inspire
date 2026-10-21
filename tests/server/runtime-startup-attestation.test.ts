import { appendFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSlot } from "../../server/runtime-slot.js";
import { deferredSignal } from "./fixtures/runtime.js";

import {
  disposeProjectionFixture,
  ProjectionRpc,
  setup,
} from "./fixtures/runtime-projection.js";

afterEach(disposeProjectionFixture);

describe("writer startup attestation", () => {
  const startupThinking = (
    parentId: string | null,
    thinkingLevel = "off",
    id = "startup1",
  ) => ({
    type: "thinking_level_change",
    id,
    parentId,
    timestamp: "2026-08-01T00:00:02.000Z",
    thinkingLevel,
  });
  it.each([null, "u1"])(
    "accepts a state-equivalent startup delta from baseline %s",
    async (parentId) => {
      const entry = startupThinking(parentId);
      const { runtime, workers } = await setup(
        [],
        (worker) => {
          worker.startupEntries = [entry];
          worker.startupLeafId = entry.id;
          worker.onStart = async () => {
            await appendFile(worker.sessionPath, `${JSON.stringify(entry)}\n`);
          };
        },
        parentId !== null,
      );
      try {
        await vi.waitFor(async () => {
          expect((await runtime.snapshot()).active?.thinkingLevel).toBe("off");
          expect(
            workers[0]!.commands.some(
              (command) => command.type === "get_commands",
            ),
          ).toBe(true);
        });
        expect(workers[0]!.commands).toContainEqual(
          parentId === null
            ? { type: "get_entries" }
            : { type: "get_entries", since: parentId },
        );
        expect(workers[0]!.stops).toBe(0);
        expect((await runtime.branchTree("session-a")).durableLeafId).toBe(
          entry.id,
        );
      } finally {
        await runtime.close();
      }
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
      const { runtime, workers } = await setup([], (worker) => {
        worker.onStart = () => start.promise;
      });
      const internals = runtime as unknown as {
        slots: Map<string, RuntimeSlot>;
        opening: Map<string, Promise<RuntimeSlot>>;
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
      const starting = internals.opening.get("session-a")!;
      const outcome = starting.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        start.resolve();
        await reconcileEntered.promise;
        expect(workers[0]!.commands.at(-1)).toEqual({ type: "get_state" });
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
        expect(slot.workerProjectionRevision).toBeNull();
        expect(events.some((event) => event.type === "runtime_ready")).toBe(
          false,
        );
        retirement.resolve();
        expect(await outcome).toMatchObject({ status: 503 });
        expect(slot.ready).toBe(false);
        expect(slot.startupPhase).toBe("idle");
        expect(slot.runState).toBe("failed");
        expect(slot.workerProjectionRevision).toBeNull();
        expect(events.some((event) => event.type === "runtime_ready")).toBe(
          false,
        );
        expect(
          workers[0]!.commands.some(
            (command) => command.type === "get_commands",
          ),
        ).toBe(false);
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

  it("rejects an otherwise exact state-equivalent entry injected by the process factory before rpc.start", async () => {
    const entry = startupThinking("u1");
    const { runtime, workers, sequence } = await setup([], (worker) => {
      worker.startupEntries = [entry];
      worker.startupLeafId = entry.id;
      appendFileSync(worker.sessionPath, `${JSON.stringify(entry)}\n`);
    });
    try {
      await vi.waitFor(() => expect(workers[0]!.stops).toBe(1));
      expect(sequence).not.toContain("start");
      expect(workers[0]!.commands).toEqual([]);
      expect((await runtime.snapshot()).runState).toBe("failed");
    } finally {
      await runtime.close();
    }
  });

  it.each([
    {
      name: "wrong level",
      prepare: (worker: ProjectionRpc) => {
        const entry = startupThinking("u1", "high");
        worker.startupEntries = [entry];
        worker.startupLeafId = entry.id;
        worker.stateThinkingLevel = "off";
        worker.onStart = async () => {
          await appendFile(worker.sessionPath, `${JSON.stringify(entry)}\n`);
        };
      },
    },
    {
      name: "mixed external append",
      prepare: (worker: ProjectionRpc) => {
        const own = startupThinking("u1");
        const external = {
          type: "message",
          id: "external",
          parentId: own.id,
          timestamp: "2026-08-01T00:00:03.000Z",
          message: { role: "assistant", content: "external", timestamp: 3 },
        };
        // The external append exists only on disk, not in this Pi worker.
        worker.startupEntries = [own];
        worker.startupLeafId = own.id;
        worker.onStart = async () => {
          await appendFile(
            worker.sessionPath,
            `${JSON.stringify(own)}\n${JSON.stringify(external)}\n`,
          );
        };
      },
    },
    {
      name: "bad parent",
      prepare: (worker: ProjectionRpc) => {
        const entry = startupThinking("not-u1");
        worker.startupEntries = [entry];
        worker.startupLeafId = entry.id;
        worker.onStart = async () => {
          await appendFile(worker.sessionPath, `${JSON.stringify(entry)}\n`);
        };
      },
    },
    {
      name: "rewrite",
      prepare: (worker: ProjectionRpc) => {
        const entry = startupThinking("u1");
        worker.startupEntries = [entry];
        worker.startupLeafId = entry.id;
        worker.onStart = async () => {
          const header = {
            type: "session",
            version: 3,
            id: "session-a",
            timestamp: "2026-08-01T00:00:00.000Z",
            cwd: worker.options.cwd,
          };
          const changed = {
            type: "message",
            id: "u1",
            parentId: null,
            timestamp: "2026-08-01T00:00:01.000Z",
            message: { role: "user", content: "rewritten", timestamp: 1 },
          };
          await writeFile(
            worker.sessionPath,
            `${[header, changed, entry].map((value) => JSON.stringify(value)).join("\n")}\n`,
          );
        };
      },
    },
  ])(
    "fails closed for a $name during startup attestation",
    async ({ prepare }) => {
      const { runtime, workers } = await setup([], prepare);
      try {
        await vi.waitFor(() => expect(workers[0]!.stops).toBe(1));
        expect((await runtime.snapshot()).runState).toBe("failed");
        expect(workers).toHaveLength(1);
      } finally {
        await runtime.close();
      }
    },
  );
});
