import { access, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PiRpcCancelledError,
  PiRpcOutcomeUnknownError,
} from "../../server/pi-rpc.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";
import {
  deferredSignal,
  disposeRuntimeFixture,
  fakeRuntime,
  fixtureWorkspace,
  initializeRuntimeFixture,
  persistedRecord,
  startWorker,
  trackedAttachmentStore,
  upload,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

async function fixture(
  options: NonNullable<Parameters<typeof fakeRuntime>[0]> = {},
) {
  const store = options.attachments ?? trackedAttachmentStore();
  const f = fakeRuntime({
    sessions: [await persistedRecord("a")],
    attachments: store,
    ...options,
  });
  await f.runtime.openSession("a");
  const internals = f.runtime as unknown as {
    slots: Map<string, RuntimeSlot>;
    projectionCoordinator: {
      reconcile(slot: RuntimeSlot, force?: boolean): Promise<unknown>;
    };
  };
  const slot = internals.slots.get("a")!;
  return {
    ...f,
    store,
    slot,
    reconcile: () => vi.spyOn(internals.projectionCoordinator, "reconcile"),
  };
}

it("refuses a project file removed during worker startup before dispatching input", async () => {
  const starting = deferredSignal();
  const ready = deferredSignal();
  const f = await fixture({
    configure(worker) {
      worker.start = () => {
        starting.resolve();
        return ready.promise;
      };
    },
  });
  const path = join(fixtureWorkspace, "selected.txt");
  await writeFile(path, "selected");
  const refused = expect(
    f.runtime.prompt({
      sessionId: "a",
      message: "Use the selected file",
      projectFiles: ["selected.txt"],
    }),
  ).rejects.toMatchObject({ status: 409 });
  try {
    await starting.promise;
    await unlink(path);
  } finally {
    ready.resolve();
  }
  await refused;
  expect(f.workers[0]!.commands.some(({ type }) => type === "prompt")).toBe(
    false,
  );
});

it("returns a staged attachment to its editor after a definitive Pi refusal", async () => {
  const f = await fixture();
  await startWorker(f.runtime);
  const file = await f.store.add(upload("notes.txt", "text/plain"));
  const leased = deferredSignal();
  const release = deferredSignal();
  f.workers[0]!.responseOverrides.set("prompt", async () => {
    leased.resolve();
    await release.promise;
    throw new Error("prompt rejected");
  });
  const delivery = expect(f.runtime.prompt({
    sessionId: "a", message: "First", attachmentIds: [file.id],
  })).rejects.toThrow("prompt rejected");
  try {
    await leased.promise;
    await expect(f.store.resolveForPrompt([file.id])).rejects.toThrow(/already belong/);
  } finally {
    release.resolve();
  }
  await delivery;
  const material = await f.store.resolveForPrompt([file.id]);
  f.store.restage([file.id]);
  await f.store.remove(file.id);
  await expect(access(material.files[0]!.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  { operation: "prompt", fault: "unconfirmed exit", cancelled: false },
  { operation: "prompt", fault: "confirmed exit", cancelled: false },
  { operation: "prompt", fault: "unconfirmed exit", cancelled: true },
  { operation: "prompt", fault: "projection failure", cancelled: true },
  { operation: "prompt", fault: "upload cleanup", cancelled: false },
  { operation: "bash", fault: "unconfirmed exit", cancelled: true },
] as const)(
  "keeps a $operation delivery uncertain after $fault (explicit Stop: $cancelled)",
  async ({ operation, fault, cancelled }) => {
    const f = await fixture();
    await startWorker(f.runtime);
    const worker = f.workers[0]!;
    const failure = new Error(fault);
    const retirementFails = fault === "unconfirmed exit";
    const started = deferredSignal();
    const reply = Promise.withResolvers<never>();
    const stopReal = worker.stop.bind(worker);
    const stop = vi.spyOn(worker, "stop");
    stop.mockImplementation(async () => {
      const error = new PiRpcCancelledError(operation);
      error.stopped = retirementFails
        ? Promise.reject(failure)
        : Promise.resolve();
      if (fault === "projection failure")
        f.reconcile().mockRejectedValueOnce(failure);
      if (cancelled) reply.reject(error);
      await error.stopped;
      return stopReal();
    });
    worker.responseOverrides.set(operation, () => {
      started.resolve();
      if (cancelled) return reply.promise;
      const error = new PiRpcOutcomeUnknownError(operation);
      error.stopped = retirementFails
        ? Promise.reject(failure)
        : Promise.resolve();
      throw error;
    });
    const file =
      operation === "prompt"
        ? await f.store.add(upload("notes.txt", "text/plain"))
        : null;
    if (fault === "upload cleanup")
      vi.spyOn(f.store, "releaseConsumed").mockRejectedValueOnce(failure);
    const send = expect(
      f.runtime.prompt({
        sessionId: "a",
        message: operation === "bash" ? "!echo once" : "send once",
        ...(file ? { attachmentIds: [file.id] } : {}),
      }),
    ).rejects.toMatchObject({
      outcomeUnknown: true,
      code: "PI_RPC_OUTCOME_UNKNOWN",
      status: cancelled ? 409 : 504,
    });
    try {
      await started.promise;
      if (cancelled) {
        if (operation === "bash")
          worker.emit("event", {
            type: "extension_ui_request",
            id: "bash-hook",
            method: "confirm",
          });
        const aborting = f.runtime.abort("a");
        if (retirementFails) await expect(aborting).rejects.toBe(failure);
        else await aborting;
      }
      await send;
      expect(stop).toHaveBeenCalledOnce();
      if (cancelled) expect(stop).toHaveBeenCalledWith(operation);
      expect(
        worker.commands.filter(({ type }) => type === operation),
      ).toHaveLength(1);
      if (file) {
        await f.store.remove(file.id);
        await expect(f.store.resolveForPrompt([file.id])).rejects.toThrow(
          /already belong/,
        );
      }
      if (retirementFails) {
        await expect(
          f.runtime.prompt({ sessionId: "a", message: "must not replace" }),
        ).rejects.toBe(failure);
        expect(f.workers).toHaveLength(1);
      }
    } finally {
      const closed = f.runtime.close();
      if (retirementFails) await expect(closed).rejects.toBe(failure);
      else await closed;
    }
  },
);

it.each([
  "shell projection",
  "settlement",
  "history",
  "upload cleanup",
] as const)("keeps a confirmed receipt when %s fails", async (failure) => {
  const f = await fixture();
  const { runtime, store, slot } = f;
  await startWorker(runtime);
  const worker = f.workers[0]!;
  const fault = vi.fn(() => {
    throw new Error(failure);
  });
  const shell = failure === "shell projection";
  const operation = shell ? "bash" : "prompt";
  const startsConflict = shell || failure === "settlement";
  const files =
    failure === "upload cleanup"
      ? [await store.add(upload("notes.txt", "text/plain"))]
      : [];
  worker.responseOverrides.set(operation, () => {
    if (shell)
      vi.spyOn(slot.projection!, "reconcile").mockImplementationOnce(async () => fault());
    if (failure === "history")
      vi.spyOn(slot.workerView!.index, "historyPage").mockImplementationOnce(
        fault,
      );
    return shell ? { output: "done", exitCode: 0 } : {};
  });
  if (failure === "upload cleanup")
    vi.spyOn(store, "releaseConsumed").mockImplementationOnce(async () =>
      fault(),
    );
  const retirement = new Error("Worker exit could not be confirmed");
  if (shell) vi.spyOn(worker, "stop").mockRejectedValue(retirement);
  try {
    await expect(
      runtime.prompt({
        sessionId: "a",
        message: shell ? "!echo done" : "accepted once",
        attachmentIds: files.map(({ id }) => id),
      }),
    ).resolves.toBeUndefined();
    if (failure === "settlement") {
      f.reconcile().mockImplementationOnce(async () => fault());
      worker.emit("event", { type: "agent_settled" });
      await slot.eventTail;
    }
    if (startsConflict) {
      await vi.waitFor(async () =>
        expect(
          (await runtime.snapshot("a")).active?.projectionConflict?.kind,
        ).toBe("projection-failure"),
      );
      await expect(
        runtime.prompt({ sessionId: "a", message: "do not repeat" }),
      ).rejects.toMatchObject({ status: 409 });
    } else {
      const page = (await runtime.snapshot("a")).active!.transcriptPage;
      if (failure === "history")
        await expect(
          runtime.sessionHistory("a", page.viewId, { kind: "composer" }),
        ).rejects.toThrow(failure);
      expect(
        (await runtime.sessionHistory("a", page.viewId, { kind: "composer" }))
          .entries,
      ).toContainEqual(expect.objectContaining({ text: "persisted:a" }));
      expect(worker.stops).toBe(0);
    }
    expect(
      worker.commands.filter(({ type }) => type === operation),
    ).toHaveLength(1);
    expect(fault).toHaveBeenCalledOnce();
  } finally {
    const closed = runtime.close();
    if (shell) await expect(closed).rejects.toBe(retirement);
    else await closed;
  }
});

it("fences an unresponsive compaction until its worker's retirement is confirmed", async () => {
  const f = await fixture();
  await startWorker(f.runtime);
  const worker = f.workers[0]!;
  const started = deferredSignal();
  const retirement = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<never>();
  const failure = new Error("Compaction worker is still active");
  const settled = vi.fn();
  f.runtime.on("event", ({ type }) => {
    if (type === "compaction_end") settled();
  });
  worker.responseOverrides.set("compact", () => {
    started.resolve();
    return reply.promise;
  });
  worker.responseOverrides.set("abort", () => {
    throw new Error("No cooperative cancellation");
  });
  const stopping = deferredSignal();
  vi.spyOn(worker, "stop").mockImplementation(async () => {
    const error = new PiRpcCancelledError("compact");
    error.stopped = retirement.promise;
    reply.reject(error);
    stopping.resolve();
    await retirement.promise;
  });
  try {
    const operation = f.runtime.nativeCommand({
      sessionId: "a",
      command: "compact",
    });
    const delivered = vi.fn();
    void operation.then(delivered, delivered);
    const compaction = expect(operation).rejects.toBe(failure);
    await started.promise;
    const abort = expect(f.runtime.abort("a")).rejects.toBe(failure);
    await stopping.promise;
    expect(delivered).not.toHaveBeenCalled();
    retirement.reject(failure);
    await Promise.all([compaction, abort]);
    expect(settled).not.toHaveBeenCalled();
    await expect(
      f.runtime.prompt({ sessionId: "a", message: "must not replace" }),
    ).rejects.toBe(failure);
    expect(f.workers).toHaveLength(1);
  } finally {
    retirement.resolve();
    await expect(f.runtime.close()).rejects.toBe(failure);
  }
});

it("bounds shell output to the active RPC", async () => {
  const f = await fixture();
  await expect(
    f.runtime.prompt({ sessionId: "a", message: "!! " }),
  ).rejects.toThrow(/Enter a command/);
  expect(f.workers).toHaveLength(0);
  await startWorker(f.runtime);
  const worker = f.workers[0]!;
  const sent = deferredSignal();
  const reply = Promise.withResolvers<{ output: string }>();
  const request = worker.request.bind(worker);
  vi.spyOn(worker, "request").mockImplementation(
    async (command, timeout, fence) => {
      if (command.type !== "bash") return request(command, timeout, fence);
      fence!.id = "owned";
      sent.resolve();
      return reply.promise;
    },
  );
  const update = vi.fn();
  f.runtime.on("event", (event) => {
    if (event.shellExecution && event.type === "message_update")
      update(event.message);
  });
  const execution = f.runtime.prompt({
    sessionId: "a",
    message: "!!echo exact",
  });
  try {
    await sent.promise;
    for (const id of [undefined, "other", "owned"]) {
      worker.emit("event", {
        type: "bash_execution_update",
        id,
        delta: "x".repeat(59_999) + "!",
      });
    }
    expect(update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        output: "x".repeat(49_999) + "!",
        __inspireBashPreviewTruncated: true,
      }),
    );
    reply.resolve({ output: "exact final" });
    await execution;
    worker.emit("event", {
      type: "bash_execution_update",
      id: "owned",
      delta: "late",
    });
    expect(update).toHaveBeenCalledOnce();
  } finally {
    reply.resolve({ output: "" });
  }
});
