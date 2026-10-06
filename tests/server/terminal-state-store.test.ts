import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readTerminalState,
  TerminalStateWriter,
} from "../../server/terminal-state-store.js";
import type { TerminalPersistedState } from "../../server/terminal-session-manager.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});

const state: TerminalPersistedState = {
  version: 1,
  settings: { persistOutput: false, historyRetentionDays: 30 },
  terminals: [],
  orderByProject: [],
};

describe("terminal state persistence", () => {
  it("publishes a complete state and leaves no temporary file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-state-"));
    try {
      const path = join(directory, "state.json");
      const writer = new TerminalStateWriter(path, () => state);
      writer.schedule();
      await writer.flush();
      expect(await readTerminalState(path)).toEqual(state);
      expect(await readdir(directory)).toEqual(["state.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["writeFile", "sync"] as const)(
    "cleans staging when %s fails before publication",
    async (method) => {
      const directory = await mkdtemp(join(tmpdir(), "terminal-state-"));
      const problem = new Error("Synthetic storage failure");
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        vi.spyOn(handle, method).mockRejectedValueOnce(problem);
        return handle;
      });
      try {
        const failed = vi.fn();
        const writer = new TerminalStateWriter(
          join(directory, "state.json"),
          () => state,
          failed,
        );
        writer.schedule();
        await writer.flush();
        expect(failed).toHaveBeenCalledExactlyOnceWith(problem);
        expect(await readdir(directory)).toEqual([]);
      } finally {
        vi.mocked(open).mockReset().mockImplementation(actual.open);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
