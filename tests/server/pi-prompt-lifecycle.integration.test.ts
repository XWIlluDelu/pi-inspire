import { readFile } from "node:fs/promises";

import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  disposeOperationFixture,
  eventsOf,
  fixture,
  settled,
} from "./fixtures/native-operation.js";

afterEach(disposeOperationFixture);

describe("native prompt admission and extension dialogs", () => {
  it("settles handled input without agent events or an immortal upload reference", async () => {
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
    expect((await f.attachments.collectUnreferenced()).reclaimed).toEqual([
      path,
    ]);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      f.api.prompt(f.delivery("Continue with an ordinary prompt.")),
    ).resolves.toMatchObject({ accepted: true });
    await settled(f, 1);
    expect(f.modelRequests).toHaveLength(1);
  });

  it("holds follow-up behind a real Pi preflight auto-compaction and its original prompt", async () => {
    const f = await fixture(true, 1_000);
    const first = f.delivery("First prompt owns Pi's preflight.");
    const initial = f.api.prompt(first);
    await vi.waitFor(() =>
      expect(eventsOf(f.piEvents, "compaction_start")).toHaveLength(1),
    );
    expect(await f.workers[0]!.request({ type: "get_state" })).toMatchObject({
      isStreaming: false,
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

  it("accepts an ordinary browser prompt after 35s of real pre-prompt auto-compaction, then reuses the same worker", async () => {
    const f = await fixture(true);
    const worker = f.workers[0]!;
    const pid = worker.pid;
    expect(pid).toBeTypeOf("number");
    const originalEntries = (await readFile(f.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as SessionEntry[];
    const originalIds = new Set(originalEntries.map((entry) => entry.id));
    const first = f.delivery("First synthetic prompt after slow preflight.");
    const startedAt = performance.now();
    let completed = false;
    const delivery = f.api.prompt(first);
    void delivery.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );

    await vi.waitFor(
      () => {
        expect(eventsOf(f.piEvents, "compaction_start")).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    const compactStart = eventsOf(f.piEvents, "compaction_start")[0]!;
    expect(compactStart.reason).toBe("threshold");
    expect(eventsOf(f.runtimeEvents, "prompt_pending")[0]).toMatchObject({
      sessionId: f.sessionId,
      sessionStatus: { runState: "queued" },
    });
    expect(f.modelRequests).toHaveLength(0);
    expect(eventsOf(f.piEvents, "agent_start")).toHaveLength(0);

    // Cross the former 30s RPC/browser deadline using real monotonic time.
    await delay(Math.max(0, compactStart.at + 31_000 - performance.now()));
    expect(completed).toBe(false);
    expect(worker.available).toBe(true);
    expect(worker.pid).toBe(pid);
    expect(worker.stop).not.toHaveBeenCalled();
    expect(worker.hasPendingRequest("prompt")).toBe(true);
    expect(f.modelRequests).toHaveLength(0);
    expect(eventsOf(f.piEvents, "agent_start")).toHaveLength(0);
    await expect(worker.request({ type: "get_state" })).resolves.toMatchObject({
      sessionId: f.sessionId,
      isStreaming: false,
      isCompacting: true,
    });
    expect(f.observations[0]).toMatchObject({
      method: "POST",
      status: 202,
      authorityId: first.authorityId,
      receipt: {
        accepted: false,
        pending: true,
        operationId: first.operationId,
        authorityId: first.authorityId,
      },
    });
    expect(
      f.observations.some((observation) => observation.method === "GET"),
    ).toBe(true);

    await expect(delivery).resolves.toMatchObject({ accepted: true });
    expect(performance.now() - startedAt).toBeGreaterThan(30_000);
    await settled(f, 1);
    const compactEnd = eventsOf(f.piEvents, "compaction_end")[0]!;
    expect(compactEnd).toMatchObject({
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: {
        tokensBefore: 1800,
        details: {
          fixture: "pi-operation-lifecycle",
          reason: "threshold",
          elapsedMs: expect.any(Number),
        },
      },
    });
    const details = (compactEnd.result as { details: { elapsedMs: number } })
      .details;
    // Allow timer granularity; the child always requests the full 35s delay.
    expect(details.elapsedMs).toBeGreaterThanOrEqual(34_900);
    expect(compactEnd.at - compactStart.at).toBeGreaterThan(30_000);
    expect(eventsOf(f.piEvents, "agent_start")[0]!.at).toBeGreaterThanOrEqual(
      compactEnd.at,
    );
    // HTTP and stdout are independent transports; assert their long preflight
    // interval, not which descriptor the Host's event loop happened to read first.
    expect(f.modelRequests[0]!.at - compactStart.at).toBeGreaterThan(30_000);
    expect(eventsOf(f.runtimeEvents, "compaction_end")[0]).toMatchObject({
      sessionStatus: { runState: "queued" },
    });

    const firstObservations = [...f.observations];
    expect(
      firstObservations.filter((observation) => observation.method === "POST"),
    ).toHaveLength(1);
    expect(firstObservations.at(-1)?.receipt).toMatchObject({ accepted: true });
    for (const observation of firstObservations) {
      expect(observation.status).toBe(202);
      expect(observation.authorityId).toBe(first.authorityId);
      expect(observation.completedAt! - observation.startedAt).toBeLessThan(
        30_000,
      );
      if (observation.method === "GET") {
        expect(observation.url.pathname).toBe(
          `/api/prompt/${first.operationId}`,
        );
        expect(observation.url.searchParams.get("authorityId")).toBe(
          first.authorityId,
        );
        expect(observation.body).toBeUndefined();
      }
    }
    expect(JSON.parse(String(firstObservations[0]!.body))).toEqual(first);

    const second = f.delivery(
      "Second ordinary synthetic prompt on the same worker.",
    );
    await expect(f.api.prompt(second)).resolves.toMatchObject({
      accepted: true,
    });
    await settled(f, 2);
    expect(f.workers).toHaveLength(1);
    expect(worker.available).toBe(true);
    expect(worker.pid).toBe(pid);
    expect(worker.stop).not.toHaveBeenCalled();
    expect(eventsOf(f.piEvents, "compaction_start")).toHaveLength(1);
    expect(eventsOf(f.piEvents, "extension_error")).toEqual([]);
    expect(eventsOf(f.runtimeEvents, "runtime_error")).toEqual([]);
    expect(eventsOf(f.runtimeEvents, "session_projection_conflict")).toEqual(
      [],
    );
    expect(f.modelRequests).toHaveLength(2);
    expect(f.modelRequests.map((request) => request.url)).toEqual([
      "/v1/chat/completions",
      "/v1/chat/completions",
    ]);
    expect(
      f.observations.filter((observation) => observation.method === "POST"),
    ).toHaveLength(2);
    // This is only the JSONL generated in this test's private fixture directory.
    const written = (await readFile(f.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as SessionEntry[];
    const newMessages = written.filter(
      (entry): entry is SessionMessageEntry =>
        entry.type === "message" && !originalIds.has(entry.id),
    );
    const newTurns = newMessages.filter(
      (entry) => entry.message.role !== "system",
    );
    expect(newTurns.map((entry) => entry.message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(newTurns[0]!.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: first.message }],
    });
    expect(newTurns[2]!.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: second.message }],
    });
    expect(written.filter((entry) => entry.type === "compaction")).toHaveLength(
      1,
    );
    expect(
      written.findIndex((entry) => entry.type === "compaction"),
    ).toBeLessThan(written.indexOf(newTurns[0]!));
    const snapshot = await f.runtime.snapshot();
    expect(snapshot.active?.transcriptPage.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "system" })]),
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
