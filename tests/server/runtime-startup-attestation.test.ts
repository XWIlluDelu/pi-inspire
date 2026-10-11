import { appendFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  setup,
  ProjectionRpc,
  disposeProjectionFixture,
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
    "accepts a bounded state-equivalent startup delta from baseline %s",
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

  it("accepts exact custom extension state written by the starting worker", async () => {
    const entry = {
      type: "custom",
      customType: "goal-state",
      data: { goal: { id: "goal-1", status: "active", tokensUsed: 1 } },
      id: "startup-custom",
      parentId: "u1",
      timestamp: "2026-08-01T00:00:02.000Z",
    };
    const { runtime, workers } = await setup([], (worker) => {
      worker.startupEntries = [entry];
      worker.startupLeafId = entry.id;
      worker.onStart = async () => {
        await appendFile(worker.sessionPath, `${JSON.stringify(entry)}\n`);
      };
    });
    try {
      await vi.waitFor(async () => {
        await runtime.snapshot();
        expect(
          workers[0]!.commands.some(
            (command) => command.type === "get_commands",
          ),
        ).toBe(true);
      });
      expect(workers[0]!.stops).toBe(0);
      expect((await runtime.branchTree("session-a")).durableLeafId).toBe(
        entry.id,
      );
    } finally {
      await runtime.close();
    }
  });

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
        worker.startupEntries = [own, external];
        worker.startupLeafId = external.id;
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
