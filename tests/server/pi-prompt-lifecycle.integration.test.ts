import { readFile } from "node:fs/promises";

import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSlot } from "../../server/runtime-slot.js";

import {
  disposeOperationFixture,
  eventsOf,
  fixture,
  settled,
} from "./fixtures/native-operation.js";

afterEach(disposeOperationFixture);

describe("native prompt admission and extension dialogs", () => {
  it("adopts delayed native message completions without duplicating history or hiding later turns", async () => {
    const f = await fixture(false);
    const worker = f.workers[0]!;
    const emit = worker.emit.bind(worker);
    const delayed: Array<Record<string, unknown>> = [];
    let holding = true;
    let delayedTail = false;
    const observer = vi
      .spyOn(worker, "emit")
      .mockImplementation((type, ...args) => {
        const event = args[0] as Record<string, unknown> | undefined;
        const role = (event?.message as { role?: string } | undefined)?.role;
        if (
          holding &&
          type === "event" &&
          event &&
          (delayedTail || (event.type === "message_end" && role === "user"))
        ) {
          // Delay the whole event tail, not individual completions: native
          // lifecycle order remains intact while get_entries can answer.
          delayedTail = true;
          delayed.push(event);
          return true;
        }
        return emit(type, ...args);
      });
    const release = () => {
      holding = false;
      for (const event of delayed.splice(0)) emit("event", event);
    };
    try {
      const prompt = "Retain this repeated native input.";
      await f.api.prompt(f.delivery(prompt));
      await vi.waitFor(() =>
        expect(delayed.some((event) => event.type === "agent_settled")).toBe(
          true,
        ),
      );
      expect(
        delayed
          .filter((event) => event.type === "message_end")
          .map((event) => (event.message as { role: string }).role),
      ).toEqual(["user", "assistant"]);

      // Only observation timing is gated: the real Pi already wrote these
      // messages and attests them through the ordinary get_entries protocol.
      const internals = f.runtime as unknown as {
        slots: Map<string, RuntimeSlot>;
        reconcileSlot(slot: RuntimeSlot, force: boolean): Promise<unknown>;
      };
      const slot = internals.slots.get(f.sessionId)!;
      await internals.reconcileSlot(slot, true);
      release();
      await settled(f, 1);
      await vi.waitFor(() => {
        expect(slot.overlay).toEqual([]);
        expect(slot.persistenceExpectations).toEqual([]);
      });
      const checkHistory = async (turns: number) => {
        const snapshot = await f.runtime.snapshot();
        const written = (await readFile(f.sessionFile, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)) as SessionEntry[];
        const messages = snapshot.active!.transcriptPage.messages as Array<
          Record<string, unknown>
        >;
        for (const entry of written) {
          if (
            entry.type !== "message" ||
            !["user", "assistant"].includes(entry.message.role)
          )
            continue;
          expect(
            messages.filter((message) => message.__inspireEntryId === entry.id),
          ).toHaveLength(1);
        }
        expect(
          messages.filter((message) =>
            JSON.stringify(message.content).includes(prompt),
          ),
        ).toHaveLength(turns);
        expect(messages.at(-1)).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: `Synthetic reply ${turns}.` }],
        });
        expect(messages.some((message) => message.__inspireLiveId)).toBe(false);
      };
      await checkHistory(1);

      // A deliberately repeated input is a new turn, not a duplicate to hide.
      await f.api.prompt(f.delivery(prompt));
      await settled(f, 2);
      await checkHistory(2);
      expect(worker.stop).not.toHaveBeenCalled();
      expect(eventsOf(f.runtimeEvents, "runtime_error")).toEqual([]);
    } finally {
      release();
      observer.mockRestore();
    }
  }, 20_000);

  it("settles handled input without agent events and preserves its delivered file", async () => {
    const f = await fixture(false);
    const file = await f.attachments.add({
      originalname: "handled.txt",
      mimetype: "text/plain",
      size: 7,
      buffer: Buffer.from("payload"),
    } as Express.Multer.File);
    await expect(
      f.api.prompt({
        ...f.delivery("Handled without a model turn."),
        attachmentIds: [file.id],
      }),
    ).resolves.toMatchObject({ accepted: true });
    expect(f.modelRequests).toHaveLength(0);
    expect(eventsOf(f.piEvents, "agent_start")).toHaveLength(0);
    expect((await f.runtime.snapshot()).runState).toBe("idle");
    const path = join(
      await f.attachments.uploadDirectory(),
      `${file.id}-${file.fileName}`,
    );
    expect((await readFile(f.sessionFile, "utf8")).includes(path)).toBe(false);
    expect((await f.attachments.collectStaged()).reclaimed).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("payload");

    await expect(
      f.api.prompt(f.delivery("Continue with an ordinary prompt.")),
    ).resolves.toMatchObject({ accepted: true });
    await settled(f, 1);
    expect(f.modelRequests).toHaveLength(1);
  }, 30_000);

  it("holds follow-up behind a real Pi preflight auto-compaction and its original prompt", async () => {
    const f = await fixture(true, 1_000);
    const first = f.delivery("First prompt owns Pi's preflight.");
    const initial = f.api.prompt(first);
    await vi.waitFor(() =>
      expect(eventsOf(f.piEvents, "compaction_start")).toHaveLength(1),
    );
    // Pi reports the entire active run, including preflight, as streaming.
    expect(await f.workers[0]!.request({ type: "get_state" })).toMatchObject({
      isStreaming: true,
      isCompacting: true,
    });
    const follow = {
      ...f.delivery("Follow-up from compaction."),
      behavior: "followUp" as const,
    };
    const following = f.api.prompt(follow);
    await vi.waitFor(async () =>
      expect((await f.runtime.snapshot()).pendingQueues?.totalCount).toBe(1),
    );
    expect(f.modelRequests).toHaveLength(0);
    await expect(initial).resolves.toMatchObject({ accepted: true });
    await expect(following).resolves.toMatchObject({ accepted: true });
    await vi.waitFor(
      async () => {
        expect(f.modelRequests).toHaveLength(2);
        expect((await f.runtime.snapshot()).runState).toBe("idle");
      },
      { timeout: 10_000 },
    );
    const written = (await readFile(f.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as SessionEntry[];
    const userTexts = written.flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user") return [];
      const content = entry.message.content;
      return [
        typeof content === "string"
          ? content
          : content.find((part) => part.type === "text")?.text,
      ];
    });
    expect(userTexts.slice(-2)).toEqual([first.message, follow.message]);
    expect(eventsOf(f.runtimeEvents, "runtime_error")).toEqual([]);
  }, 20_000);

  it("accepts a browser prompt past the former 30s preflight limit and reuses the worker", async () => {
    const f = await fixture(true);
    const worker = f.workers[0]!;
    const pid = worker.pid;
    expect(pid).toBeTypeOf("number");
    const originalIds = new Set(
      (await readFile(f.sessionFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as SessionEntry).id),
    );
    const first = f.delivery("First synthetic prompt after slow preflight.");
    const delivery = f.api.prompt(first);
    await vi.waitFor(() =>
      expect(eventsOf(f.piEvents, "compaction_start")).toHaveLength(1),
    );
    const started = eventsOf(f.piEvents, "compaction_start")[0]!.at;
    await delay(Math.max(0, started + 31_000 - performance.now()));
    expect(worker.hasPendingRequest("prompt")).toBe(true);
    expect(f.modelRequests).toHaveLength(0);
    expect(f.observations[0]?.receipt).toMatchObject({
      accepted: false,
      pending: true,
      operationId: first.operationId,
    });

    await expect(delivery).resolves.toMatchObject({ accepted: true });
    await settled(f, 1);
    expect(
      f.observations.filter(({ method }) => method === "POST"),
    ).toHaveLength(1);
    expect(
      eventsOf(f.piEvents, "compaction_end")[0]!.at - started,
    ).toBeGreaterThan(30_000);

    const second = f.delivery(
      "Second ordinary synthetic prompt on the same worker.",
    );
    await expect(f.api.prompt(second)).resolves.toMatchObject({
      accepted: true,
    });
    await settled(f, 2);
    expect(f.workers).toEqual([worker]);
    expect(worker.pid).toBe(pid);
    expect(worker.stop).not.toHaveBeenCalled();
    expect(f.modelRequests).toHaveLength(2);
    const written = (await readFile(f.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionEntry)
      .filter((entry) => !originalIds.has(entry.id));
    const turns = written.filter(
      (entry): entry is SessionMessageEntry =>
        entry.type === "message" && entry.message.role !== "system",
    );
    expect(turns.map(({ message }) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(turns[0]!.message).toMatchObject({
      content: [{ type: "text", text: first.message }],
    });
    expect(turns[2]!.message).toMatchObject({
      content: [{ type: "text", text: second.message }],
    });
    const compaction = written.filter((entry) => entry.type === "compaction");
    expect(compaction).toHaveLength(1);
    expect(written.indexOf(compaction[0]!)).toBeLessThan(
      written.indexOf(turns[0]!),
    );
  }, 90_000);

  it("keeps an independent command's dialog answerable when the model settles", async () => {
    let releaseModel!: () => void;
    const modelReplyGate = new Promise<void>((resolveReply) => {
      releaseModel = resolveReply;
    });
    try {
      const f = await fixture(false, 0, modelReplyGate);
      await f.api.prompt(
        f.delivery("Reply after the command opens its dialog."),
      );
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      const command = f.api.prompt(f.delivery("/await"));
      void command.catch(() => {});
      await vi.waitFor(async () =>
        expect(
          (await f.runtime.snapshot()).pendingExtensionUiRequests,
        ).toHaveLength(1),
      );
      const dialog = (await f.runtime.snapshot())
        .pendingExtensionUiRequests![0]!;
      releaseModel();
      await settled(f, 1);
      expect(f.workers[0]!.hasPendingRequest("prompt")).toBe(true);
      expect((await f.runtime.snapshot()).pendingExtensionUiRequests).toEqual([
        dialog,
      ]);
      expect(eventsOf(f.runtimeEvents, "extension_ui_clear")).toEqual([]);
      await f.runtime.extensionUiResponse({
        sessionId: f.sessionId,
        id: dialog.id,
        confirmed: true,
      });
      await expect(command).resolves.toMatchObject({ accepted: true });
      expect((await f.runtime.snapshot()).pendingExtensionUiRequests).toEqual(
        [],
      );
      expect(f.workers).toHaveLength(1);
      expect(f.workers[0]!.stop).not.toHaveBeenCalled();
      expect(eventsOf(f.runtimeEvents, "runtime_error")).toEqual([]);
    } finally {
      releaseModel();
    }
  }, 20_000);

  it("keeps /await pending until a UI answer and lets explicit Stop interrupt the next preflight outside the writer FIFO", async () => {
    const f = await fixture(false);
    const worker = f.workers[0]!;
    const pid = worker.pid;
    const answered = f.api.prompt(f.delivery("/await"));
    let completed = false;
    void answered.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    await vi.waitFor(() =>
      expect(f.observations[0]?.receipt).toMatchObject({ pending: true }),
    );
    const pending = await f.runtime.snapshot();
    expect(pending.runState).toBe("queued");
    expect(pending.pendingExtensionUiRequests).toHaveLength(1);
    const dialog = pending.pendingExtensionUiRequests![0]!;
    expect(dialog).toMatchObject({ method: "confirm", sessionId: f.sessionId });
    expect(completed).toBe(false);
    await f.runtime.extensionUiResponse({
      sessionId: f.sessionId,
      id: dialog.id,
      confirmed: true,
    });
    await expect(answered).resolves.toMatchObject({ accepted: true });
    expect((await f.runtime.snapshot()).runState).toBe("idle");
    expect(worker.pid).toBe(pid);
    expect(worker.stop).not.toHaveBeenCalled();
    expect(f.modelRequests).toHaveLength(0);

    const stopped = f.api.prompt(f.delivery("/await"));
    void stopped.catch(() => {}); // The explicit Stop may reject before we await it.
    await vi.waitFor(async () => {
      expect(
        (await f.runtime.snapshot()).pendingExtensionUiRequests,
      ).toHaveLength(1);
    });
    const stopStarted = performance.now();
    await f.runtime.abort(f.sessionId);
    expect(performance.now() - stopStarted).toBeLessThan(5_000);
    await expect(stopped).rejects.toMatchObject({ outcomeUnknown: true });
    expect(worker.stop).toHaveBeenCalledWith("prompt");
    expect(worker.available).toBe(false);
    expect(worker.pid).toBeNull();
    expect(f.workers).toHaveLength(1);
    const final = await f.runtime.snapshot();
    expect(final.pendingExtensionUiRequests).toEqual([]);
    expect(final.runState).not.toBe("queued");
    expect(f.modelRequests).toHaveLength(0);
  }, 20_000);
});
