import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addAttachmentContext } from "../../server/attachments.js";
import { MAX_ATTACHMENTS } from "../../shared/contracts.js";
import {
  PiRpcCancelledError,
  PiRpcOutcomeUnknownError,
} from "../../server/pi-rpc.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";
import {
  deferredSignal,
  disposeRuntimeFixture,
  fakeRuntime,
  fixtureWorkspace,
  initializeRuntimeFixture,
  persistedRecord,
  preview,
  record,
  startWorker,
  trackedAttachmentStore,
  trackRuntime,
  upload,
} from "./fixtures/runtime.js";
import { messageEntry } from "./fixtures/session-jsonl.js";

beforeEach(async () => {
  await initializeRuntimeFixture();
  const pi = await nativePiWorkspace(
    "pi-",
    { defaultProjectTrust: "never" },
    fixtureWorkspace,
  );
  stubNativePiEnvironment(pi.env);
});
afterEach(async () => {
  try {
    await disposeRuntimeFixture();
  } finally {
    vi.unstubAllEnvs();
  }
});

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
    reconcileSlot(slot: RuntimeSlot, force?: boolean): Promise<unknown>;
  };
  const slot = internals.slots.get("a")!;
  return {
    ...f,
    store,
    slot,
    reconcile: () => vi.spyOn(internals, "reconcileSlot"),
  };
}

it("opens the saved view cold and rechecks a selected file at prompt dispatch", async () => {
  const held = deferredSignal();
  const ready = deferredSignal();
  const f = await fixture({
    configure(worker) {
      worker.start = async () => {
        held.resolve();
        await ready.promise;
      };
    },
  });
  trackRuntime(f.runtime);
  expect(f.workers).toHaveLength(0);
  expect(
    (await f.runtime.snapshot("a")).active?.transcriptPage.messages,
  ).toMatchObject([{ role: "user", content: "persisted:a" }]);
  const selected = join(fixtureWorkspace, "selected.txt");
  await writeFile(selected, "selected");
  const prompt = () =>
    f.runtime.prompt({
      sessionId: "a",
      message: "Use the selected file",
      projectFiles: ["selected.txt"],
    });
  try {
    const refused = expect(prompt()).rejects.toMatchObject({
      status: 409,
      message: "A selected project file changed before prompt delivery",
    });
    await held.promise;
    await rm(selected);
    ready.resolve();
    await refused;
    expect(
      f.workers[0]!.commands.filter(({ type }) => type === "prompt"),
    ).toEqual([]);
    await writeFile(selected, "reselected");
    await prompt();
    expect(
      f.workers[0]!.commands.find(({ type }) => type === "prompt")?.message,
    ).toContain(JSON.stringify(selected));
  } finally {
    ready.resolve();
  }
});

it.each(["accepted", "Pi refusal", "invalid project file"] as const)(
  "returns the original attachment lease after %s",
  async (result) => {
    const f = await fixture();
    trackRuntime(f.runtime);
    await startWorker(f.runtime);
    const file = await f.store.add(upload("notes.txt", "text/plain"));
    const leased = deferredSignal();
    const release = deferredSignal();
    const resolve = f.store.resolveForPrompt.bind(f.store);
    let path: string;
    vi.spyOn(f.store, "resolveForPrompt").mockImplementationOnce(
      async (ids) => {
        const material = await resolve(ids);
        path = material.files[0]!.path;
        leased.resolve();
        await release.promise;
        return material;
      },
    );
    if (result === "Pi refusal")
      f.workers[0]!.responseOverrides.set("prompt", () => {
        throw new Error("prompt rejected");
      });
    const send = f.runtime.prompt({
      sessionId: "a",
      message: "First",
      attachmentIds: [file.id],
      ...(result === "invalid project file"
        ? { projectFiles: ["absent.txt"] }
        : {}),
    });
    const completed = vi.fn();
    void send.then(completed, completed);
    try {
      await leased.promise;
      await expect(
        f.runtime.prompt({
          sessionId: "a",
          message: "Concurrent",
          attachmentIds: [file.id],
        }),
      ).rejects.toThrow(/already belong/);
      await f.store.remove(file.id);
      await expect(access(path!)).resolves.toBeUndefined();
      expect(completed).not.toHaveBeenCalled();
      release.resolve();
      if (result === "accepted") await send;
      else if (result === "Pi refusal")
        await expect(send).rejects.toThrow("prompt rejected");
      else await expect(send).rejects.toMatchObject({ code: "ENOENT" });
      await f.store.remove(file.id);
      if (result === "accepted")
        await expect(access(path!)).resolves.toBeUndefined();
      else
        await expect(access(path!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release.resolve();
    }
  },
);

it.each([
  { operation: "prompt", fault: "unconfirmed exit", cancelled: false },
  { operation: "prompt", fault: "confirmed exit", cancelled: false },
  { operation: "prompt", fault: "unconfirmed exit", cancelled: true },
  { operation: "prompt", fault: "projection failure", cancelled: true },
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
  "prompt projection",
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
  const projection = slot.projection!;
  const failReconcile = () =>
    vi
      .spyOn(projection, "reconcile")
      .mockImplementationOnce(async () => fault());
  const startsConflict =
    failure.endsWith("projection") || failure === "settlement";
  const files =
    failure === "upload cleanup"
      ? [await store.add(upload("notes.txt", "text/plain"))]
      : [];
  worker.responseOverrides.set(operation, () => {
    if (failure.endsWith("projection")) failReconcile();
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
    ).resolves.toEqual(
      shell ? { text: "!echo done", images: [], files: [] } : null,
    );
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

it("publishes only the owned shell request's bounded output and exact reply", async () => {
  const f = await fixture();
  trackRuntime(f.runtime);
  for (const message of ["!", "!! "])
    await expect(f.runtime.prompt({ sessionId: "a", message })).rejects.toThrow(
      /Enter a command/,
    );
  expect(f.workers).toHaveLength(0);
  await startWorker(f.runtime);
  const worker = f.workers[0]!;
  const sent = deferredSignal();
  const hold = Promise.withResolvers<Record<string, unknown>>();
  const request = worker.request.bind(worker);
  vi.spyOn(worker, "request").mockImplementation(
    async (command, timeout, fence) => {
      if (command.type !== "bash") return request(command, timeout, fence);
      expect(command).toEqual({
        type: "bash",
        command: "echo exact",
        excludeFromContext: true,
      });
      fence!.id = "owned";
      sent.resolve();
      return hold.promise;
    },
  );
  const events: Record<string, unknown>[] = [];
  f.runtime.on("event", (event) => {
    if (event.shellExecution) events.push(event);
  });
  const execution = f.runtime.prompt({
    sessionId: "a",
    message: "!!echo exact",
  });
  try {
    await sent.promise;
    for (const [id, delta] of [
      [undefined, "untagged"],
      ["other", "unowned"],
      ["owned", "x".repeat(59_999) + "!"],
    ] as const)
      worker.emit("event", { type: "bash_execution_update", id, delta });
    expect(events.filter(({ type }) => type === "message_update")).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          output: "x".repeat(49_999) + "!",
          __inspireBashPreviewTruncated: true,
        }),
      }),
    ]);
    hold.resolve({ output: "EXACT_FINAL", exitCode: 9, truncated: true });
    await expect(execution).resolves.toEqual({
      text: "!!echo exact",
      files: [],
      images: [],
    });
    expect(events.at(-1)).toMatchObject({
      type: "message_end",
      message: { output: "EXACT_FINAL", exitCode: 9 },
    });
    const count = events.length;
    worker.emit("event", {
      type: "bash_execution_update",
      id: "owned",
      delta: "late",
    });
    expect(events).toHaveLength(count);
  } finally {
    hold.resolve({});
  }
});

it("checks the recalled view and consumes a full set of attachments while preserving durable files", async () => {
  const cwd = join(fixtureWorkspace, "project");
  const store = trackedAttachmentStore();
  const report = await store.add(upload("report.pdf", "application/pdf"));
  const {
    files: [file],
  } = await store.resolveForPrompt([report.id]);
  await store.releaseConsumed([report.id]);
  // Hidden or newly ignored regular project paths retain their native authority.
  await mkdir(join(cwd, ".settings"));
  const selected = join(cwd, ".settings", "source.ts");
  await writeFile(selected, "source");
  await writeFile(join(cwd, ".gitignore"), ".settings/\n");
  const forged = join(fixtureWorkspace, "outside-fixture.txt");
  await writeFile(forged, "not authorized through this workspace");
  const recalled = { type: "image", data: "cGl4ZWxz", mimeType: "image/png" };
  const original = addAttachmentContext("original", [file!], [selected]);
  const f = await fixture({
    attachments: store,
    sessions: [record("a", cwd)],
    openSessionProjection: (session) =>
      preview(session, [
        messageEntry("original", null, {
          role: "user",
          timestamp: 1,
          content: [
            {
              type: "text",
              text:
                original +
                "\n\n[Image: original 2560x133, displayed at 2000x104. Multiply coordinates by 1.28 to map to original image.]",
            },
            recalled,
          ],
        }),
        messageEntry("forged", "original", {
          role: "user",
          timestamp: 2,
          content: addAttachmentContext(
            "forged",
            [{ kind: "file", path: forged }],
            [],
          ),
        }),
      ]),
  });
  trackRuntime(f.runtime);
  await startWorker(f.runtime);
  const view = (await f.runtime.snapshot("a")).active!.transcriptPage;
  const history = await f.runtime.sessionHistory("a", view.viewId, {
    kind: "composer",
  });
  const saved = history.entries.find(({ text }) => text === "original")!;
  const outside = history.entries.find(({ text }) => text === "forged")!;
  expect(saved.files.map(({ fileName, kind }) => [fileName, kind])).toEqual([
    ["source.ts", "project"],
    ["report.pdf", "attachment"],
  ]);
  const send = (
    entry: typeof saved,
    viewId = history.viewId,
    attachmentIds?: string[],
  ) =>
    f.runtime.prompt({
      sessionId: "a",
      message: "again",
      attachmentIds,
      historyArtifacts: {
        viewId,
        incarnation: history.incarnation ?? null,
        effectiveLeafId: history.effectiveLeafId ?? null,
        imageReferences: entry.images.map(({ reference }) => reference),
        fileReferences: entry.files.map(({ reference }) => reference),
      },
    });
  await expect(send(saved, "different-view")).rejects.toMatchObject({
    status: 409,
  });
  await expect(send(outside)).rejects.toMatchObject({ status: 409 });
  const images = await store.addMany(
    Array.from({ length: MAX_ATTACHMENTS - 2 }, (_, index) =>
      upload(`image-${index}.png`, "image/png"),
    ),
  );
  await send(
    saved,
    history.viewId,
    images.map(({ id }) => id),
  );
  const delivery = f.workers[0]!.commands.filter(
    ({ type }) => type === "prompt",
  );
  expect(delivery).toHaveLength(1);
  expect(delivery[0]).toMatchObject({
    message: addAttachmentContext("again", [file!], [selected]),
    images: expect.arrayContaining([recalled]),
  });
  expect(delivery[0]!.images).toHaveLength(MAX_ATTACHMENTS - 1);
  for (const { id } of images)
    await expect(store.imagePreview(id)).rejects.toMatchObject({ status: 404 });
  await store.remove(report.id);
  await expect(access(file!.path)).resolves.toBeUndefined();
});
