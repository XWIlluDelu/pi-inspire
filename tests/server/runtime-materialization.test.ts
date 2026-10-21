import { catalog } from "./fixtures/runtime.js";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AttachmentStore } from "../../server/attachments.js";

import { type PiRpcProcess } from "../../server/pi-rpc.js";
import { MAX_IDLE_WORKERS, RuntimeController } from "../../server/runtime.js";

import {
  setupNewSession,
  directories,
  stores,
  NewSessionRpc,
  disposeProjectionFixture,
} from "./fixtures/runtime-projection.js";

afterEach(disposeProjectionFixture);

describe("new-session materialization", () => {
  it("returns an empty session before its JSONL exists and accepts the exact first Pi flush", async () => {
    const fixture = await setupNewSession();
    try {
      const created = await fixture.runtime.newSession(fixture.directory);
      expect(created.active).toMatchObject({
        sessionId: "new-session",
        sessionFile: fixture.path,
        transcriptPage: { messages: [] },
        projectionHealth: { status: "ok" },
      });
      await expect(access(fixture.path)).rejects.toMatchObject({
        code: "ENOENT",
      });

      await fixture.runtime.rename("new-session", "Named before first prompt");
      await expect(access(fixture.path)).rejects.toMatchObject({
        code: "ENOENT",
      });

      await fixture.runtime.prompt({
        sessionId: "new-session",
        message: "first prompt",
        attachmentIds: [],
        projectFiles: [],
      });
      const snapshot = await fixture.runtime.snapshot();
      expect(snapshot.active?.transcriptPage.messages).toEqual([
        expect.objectContaining({ role: "user", content: "first prompt" }),
        expect.objectContaining({ role: "assistant" }),
      ]);
      expect(snapshot.active?.projectionHealth).toEqual({ status: "ok" });
      expect(snapshot.active?.projectionConflict).toBeNull();
      expect(fixture.worker.stops).toBe(0);
    } finally {
      await fixture.runtime.close();
    }
  });

  it("accepts header-only and complete-line prefixes from one first flush", async () => {
    let runtime!: RuntimeController;
    const observations: Array<{
      lineCount: number;
      messages: number;
      conflict: unknown;
    }> = [];
    const fixture = await setupNewSession((worker) => {
      worker.emitEventsBeforeWrite = false;
      worker.materializationCuts = [1, 3];
      worker.onMaterializationCut = async (lineCount) => {
        const snapshot = await runtime.snapshot();
        observations.push({
          lineCount,
          messages: snapshot.active?.transcriptPage.messages.length ?? -1,
          conflict: snapshot.active?.projectionConflict,
        });
      };
    });
    runtime = fixture.runtime;
    try {
      await runtime.newSession(fixture.directory);
      await runtime.prompt({
        sessionId: "new-session",
        message: "first prompt",
        attachmentIds: [],
        projectFiles: [],
      });
      expect(observations).toEqual([
        { lineCount: 1, messages: 0, conflict: null },
        { lineCount: 3, messages: 0, conflict: null },
      ]);
      fixture.worker.emitPromptEvents();
      const snapshot = await runtime.snapshot();
      expect(snapshot.active?.transcriptPage.messages).toHaveLength(2);
      expect(snapshot.active?.projectionConflict).toBeNull();
      expect(fixture.worker.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("accepts first materialization before its message events reach the host", async () => {
    const fixture = await setupNewSession((worker) => {
      worker.emitEventsBeforeWrite = false;
    });
    try {
      await fixture.runtime.newSession(fixture.directory);
      await fixture.runtime.prompt({
        sessionId: "new-session",
        message: "first prompt",
        attachmentIds: [],
        projectFiles: [],
      });
      expect(
        (await fixture.runtime.snapshot()).active?.projectionConflict,
      ).toBeNull();

      fixture.worker.emitPromptEvents();
      fixture.worker.emitEventsBeforeWrite = true;
      fixture.worker.reusePromptTimestamps = true;
      await fixture.runtime.prompt({
        sessionId: "new-session",
        message: "second prompt",
        attachmentIds: [],
        projectFiles: [],
      });
      const snapshot = await fixture.runtime.snapshot();
      expect(snapshot.active?.projectionConflict).toBeNull();
      expect(snapshot.active?.transcriptPage.messages).toHaveLength(4);
    } finally {
      await fixture.runtime.close();
    }
  });

  it("does not commit a new session after an optional read loses its worker", async () => {
    const fixture = await setupNewSession((worker) => {
      const request = worker.request.bind(worker);
      worker.request = async <T>(command: Record<string, unknown>) => {
        if (command.type === "get_commands") {
          worker.unavailable = true;
          throw new Error("worker transport lost");
        }
        return request<T>(command);
      };
    });

    try {
      await expect(
        fixture.runtime.newSession(fixture.directory),
      ).rejects.toThrow("worker transport lost");
      expect(fixture.worker.stops).toBe(1);
      expect((await fixture.runtime.snapshot()).active).toBeNull();
    } finally {
      await fixture.runtime.close();
    }
  });

  it("bounds idle unmaterialized workers with the existing LRU", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "inspire-runtime-pending-lru-"),
    );
    directories.push(directory);
    const attachments = new AttachmentStore(join(directory, "uploads"));
    stores.push(attachments);
    const workers: NewSessionRpc[] = [];
    const runtime = new RuntimeController(
      catalog([]),
      attachments,
      (options) => {
        const index = workers.length + 1;
        const worker = new NewSessionRpc(
          options,
          join(directory, `future-${index}.jsonl`),
          `new-session-${index}`,
        );
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
    );

    try {
      for (let index = 0; index < MAX_IDLE_WORKERS + 2; index += 1)
        await runtime.newSession(directory);
      await vi.waitFor(() =>
        expect(workers.filter((worker) => worker.stops > 0)).toHaveLength(1),
      );
      expect(workers.at(-1)?.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("rejects a mismatched file that appears between worker capture and projection open", async () => {
    const fixture = await setupNewSession((worker) => {
      const request = worker.request.bind(worker);
      worker.request = async <T>(command: Record<string, unknown>) => {
        const result = await request<T>(command);
        if (command.type === "get_entries") {
          const header = {
            type: "session",
            version: 3,
            id: worker.sessionId,
            timestamp: "2026-08-01T00:00:00.000Z",
            cwd: join(worker.options.cwd, "other-project"),
          };
          await writeFile(
            worker.sessionPath,
            `${[header, ...worker.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
          );
        }
        return result;
      };
    });

    try {
      await expect(
        fixture.runtime.newSession(fixture.directory),
      ).rejects.toMatchObject({ status: 409 });
      expect(fixture.worker.stops).toBe(1);
    } finally {
      await fixture.runtime.close();
    }
  });

  it.each([false, true])(
    "keeps an accepted first prompt non-retryable on projection conflict (stop fails: %s)",
    async (stopFails) => {
      const fixture = await setupNewSession((worker) => {
        if (stopFails) {
          worker.stop = async () => {
            worker.stops += 1;
            throw new Error("Fixture stop could not confirm exit");
          };
        }
        const request = worker.request.bind(worker);
        worker.request = async <T>(command: Record<string, unknown>) => {
          if (command.type !== "prompt") return request<T>(command);
          const result = await request<T>(command);
          const lines = (await readFile(worker.sessionPath, "utf8"))
            .trim()
            .split("\n");
          const injected = {
            type: "custom",
            customType: "external",
            data: {},
            id: "external-1",
            parentId: "thinking-1",
            timestamp: "2026-08-01T00:00:03.500Z",
          };
          lines.splice(3, 0, JSON.stringify(injected));
          await writeFile(worker.sessionPath, `${lines.join("\n")}\n`);
          return result;
        };
      });

      try {
        const image = await fixture.attachments.add({
          originalname: "first.png",
          mimetype: "image/png",
          size: 3,
          buffer: Buffer.from("png"),
        } as Express.Multer.File);
        await fixture.runtime.newSession(fixture.directory);
        await expect(
          fixture.runtime.prompt({
            sessionId: "new-session",
            message: "first prompt",
            attachmentIds: [image.id],
            projectFiles: [],
          }),
        ).resolves.toBeNull();
        await expect(
          fixture.attachments.resolveForPrompt([image.id]),
        ).rejects.toThrow(/expired/);
        expect(fixture.worker.stops).toBe(1);
        expect((await fixture.runtime.snapshot()).runState).toBe("conflict");
        await expect(
          fixture.runtime.prompt({
            sessionId: "new-session",
            message: "retry",
          }),
        ).rejects.toMatchObject({ status: 409 });
        expect(
          fixture.worker.commands.filter(
            (command) => command.type === "prompt",
          ),
        ).toHaveLength(1);
      } finally {
        if (stopFails)
          await expect(fixture.runtime.close()).rejects.toThrow(
            "Fixture stop could not confirm exit",
          );
        else await expect(fixture.runtime.close()).resolves.toBeUndefined();
      }
    },
  );
});
