import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAttachmentContext } from "../../server/attachments.js";

import {
  PiRpcCancelledError,
  PiRpcOutcomeUnknownError,
} from "../../server/pi-rpc.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";

import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "./fixtures/host-api.js";
import {
  deferredSignal,
  disposeRuntimeFixture,
  fakeRuntime,
  fixtureWorkspace,
  initializeRuntimeFixture,
  persistedRecord,
  preview,
  record,
  schedulingRuntime,
  trackedAttachmentStore,
  trackRuntime,
  upload,
  waitForReady,
  workspaceDirectories,
} from "./fixtures/runtime.js";

import { messageEntry } from "./fixtures/session-jsonl.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("prompt admission and artifact ownership", () => {
  it("reads the saved preview during startup and revalidates project files before dispatch", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "inspire-runtime-project-revalidate-"),
    );
    workspaceDirectories.push(workspace);
    const selected = join(workspace, "selected.txt");
    await writeFile(selected, "selected");
    const { promise: gate, resolve: release } = deferredSignal();
    const f = schedulingRuntime({
      sessions: [record("a", workspace)],
      configure(worker) {
        worker.startGate = gate;
      },
    });
    const { runtime } = f;

    try {
      const opened = await runtime.openSession("a");
      expect(opened.active?.transcriptPage.messages).toMatchObject([
        { role: "user", content: "preview:a", timestamp: 1 },
      ]);
      await vi.waitFor(() => expect(f.workers[0]?.starts).toBe(1));
      const { worker } = f;
      const prompting = runtime.prompt({
        sessionId: "a",
        message: "use the selected file",
        projectFiles: ["selected.txt"],
      });
      const slots = (
        runtime as unknown as {
          slots: Map<string, { mutationQueue: { pending: number } }>;
        }
      ).slots;
      await vi.waitFor(() =>
        expect(slots.get("a")?.mutationQueue.pending).toBe(2),
      );

      const delivered = () =>
        worker.commands.filter(({ type }) => type === "prompt");
      expect(delivered()).toEqual([]);
      await rm(selected);
      release();
      await expect(prompting).rejects.toMatchObject({
        status: 409,
        message: "A selected project file changed before prompt delivery",
      });
      expect(delivered()).toEqual([]);
      await writeFile(selected, "reselected");
      await runtime.prompt({
        sessionId: "a",
        message: "use the selected file",
        projectFiles: ["selected.txt"],
      });
      expect(delivered()).toEqual([
        expect.objectContaining({
          message: expect.stringContaining(
            JSON.stringify(await realpath(selected)),
          ),
        }),
      ]);
    } finally {
      release();
      await runtime.close();
    }
  });

  it("keeps a file through concurrent reuse and withdrawal before and after delivery", async () => {
    const store = trackedAttachmentStore();
    const { promise: gate, resolve: release } = deferredSignal();
    const f = schedulingRuntime({
      attachments: store,
      configure: (worker) => {
        worker.startGate = gate;
      },
    });
    const { runtime } = f;
    await runtime.openSession("a");

    const doc = await store.add(upload("notes.txt", "text/plain"));
    const prompting = runtime.prompt({
      sessionId: "a",
      message: "first",
      attachmentIds: [doc.id],
    });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    await expect(
      runtime.prompt({
        sessionId: "a",
        message: "second",
        attachmentIds: [doc.id],
      }),
    ).rejects.toThrow(/already belong/);
    // Neither the rejected prompt's failure path nor a racing DELETE may
    // break the lease the first prompt still holds.
    await store.remove(doc.id);
    release();
    await prompting;

    const promptCommand = f.worker.commands.find(
      (command) => command.type === "prompt",
    );
    const referenced = JSON.parse(
      String(promptCommand?.message ?? "").split("\n- ")[1]!,
    ) as string;
    await expect(access(referenced)).resolves.toBeUndefined();
    await store.remove(doc.id);
    await expect(access(referenced)).resolves.toBeUndefined();
    await runtime.close();
  });

  it("settles the lease handback before a failed prompt's response", async () => {
    const store = trackedAttachmentStore();
    const { promise: resolveGate, resolve: releaseResolve } = deferredSignal();
    // Hold the resolve open past its lease-taking, like a slow image read,
    // while the project-file branch fails fast.
    const innerResolve = store.resolveForPrompt.bind(store);
    store.resolveForPrompt = async (ids?: string[]) => {
      const resolved = await innerResolve(ids);
      await resolveGate;
      return resolved;
    };
    const { runtime } = schedulingRuntime({
      attachments: store,
    });
    await runtime.openSession("a");

    const doc = await store.add(upload("notes.txt", "text/plain"));
    let rejected = false;
    const prompting = runtime.prompt({
      sessionId: "a",
      message: "use it",
      attachmentIds: [doc.id],
      projectFiles: ["/definitely/not/in/project"],
    });
    prompting.catch(() => {
      rejected = true;
    });
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 25));
    // The failure response must wait for the leases to come home: a client
    // reacting to the error instantly may withdraw the attachment.
    expect(rejected).toBe(false);

    releaseResolve();
    await expect(prompting).rejects.toThrow();
    // By the time the client sees the failure, withdrawal works again.
    await store.remove(doc.id);
    await expect(store.resolveForPrompt([doc.id])).rejects.toThrow(/expired/);
    await runtime.close();
  });

  it("restages attachments when Pi rejects the prompt so they stay withdrawable", async () => {
    const store = trackedAttachmentStore();
    const f = schedulingRuntime({ attachments: store });
    const { runtime } = f;
    await runtime.openSession("a");
    await waitForReady(runtime);
    f.worker.failPrompts = true;

    const doc = await store.add(upload("notes.txt", "text/plain"));
    await expect(
      runtime.prompt({
        sessionId: "a",
        message: "use the note",
        attachmentIds: [doc.id],
      }),
    ).rejects.toThrow("prompt rejected");
    // Failed delivery restages the file: the withdrawal now works.
    await store.remove(doc.id);
    await expect(store.resolveForPrompt([doc.id])).rejects.toThrow(/expired/);
    await runtime.close();
  });

  it.each([true, false])(
    "does not restage or duplicate unknown prompt delivery (exit confirmed: %s)",
    async (confirmed) => {
      const store = trackedAttachmentStore();
      const f = fakeRuntime({
        sessions: [await persistedRecord("a")],
        attachments: store,
        configure(worker) {
          const exitFailure = new Error("Worker exit unconfirmed");
          worker.responseOverrides.set("prompt", () => {
            const error = new PiRpcOutcomeUnknownError("prompt");
            error.stopped = confirmed
              ? Promise.resolve()
              : Promise.reject(exitFailure);
            throw error;
          });
          if (!confirmed)
            worker.stop = async () => {
              throw exitFailure;
            };
        },
      });
      const { runtime } = f;
      await runtime.openSession("a");
      const doc = await store.add(upload("notes.txt", "text/plain"));
      await expect(
        runtime.prompt({
          sessionId: "a",
          message: "send once",
          attachmentIds: [doc.id],
        }),
      ).rejects.toMatchObject({
        outcomeUnknown: true,
        message: expect.stringMatching(/outcome is unknown/),
      });
      expect(
        f.worker.commands.filter((command) => command.type === "prompt"),
      ).toHaveLength(1);
      await expect(
        runtime.prompt({
          sessionId: "a",
          message: "do not retry",
          attachmentIds: [doc.id],
        }),
      ).rejects.toThrow(/already belong/);
      expect(
        f.worker.commands.filter((command) => command.type === "prompt"),
      ).toHaveLength(1);
      await store.remove(doc.id);
      await expect(store.resolveForPrompt([doc.id])).rejects.toThrow(
        /already belong/,
      );
      if (confirmed) await expect(runtime.close()).resolves.toBeUndefined();
      else
        await expect(runtime.close()).rejects.toThrow(
          "Worker exit unconfirmed",
        );
    },
  );

  it.each(["stop", "reconciliation"] as const)(
    "retains an unknown prompt receipt when cancellation %s fails",
    async (failure) => {
      const store = trackedAttachmentStore();
      const { runtime, workers } = fakeRuntime({
        sessions: [await persistedRecord("a")],
        attachments: store,
      });
      await runtime.openSession("a");
      await waitForReady(runtime);
      const internal = runtime as unknown as {
        slots: Map<string, RuntimeSlot>;
        reconcileSlot(slot: RuntimeSlot, force?: boolean): Promise<unknown>;
        logRuntimeError(
          sessionId: string,
          error: unknown,
          event?: string,
        ): void;
      };
      const slot = internal.slots.get("a")!;
      const stopEpoch = slot.inputStopEpoch;
      const worker = workers[0]!;
      const dispatched = deferredSignal();
      let rejectPrompt!: (error: Error) => void;
      worker.responseOverrides.set(
        "prompt",
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectPrompt = reject;
            dispatched.resolve();
          }),
      );
      const cleanupError = new Error(`Cancellation ${failure} failed`);
      const reconcile = vi.spyOn(internal, "reconcileSlot");
      const logged = vi.spyOn(internal, "logRuntimeError");
      const restage = vi.spyOn(store, "restage");
      const stop = vi.spyOn(worker, "stop").mockImplementation((command) => {
        expect(command).toBe("prompt");
        const stopped =
          failure === "stop" ? Promise.reject(cleanupError) : Promise.resolve();
        if (failure === "reconciliation")
          reconcile.mockRejectedValueOnce(cleanupError);
        const error = new PiRpcCancelledError("prompt");
        error.stopped = stopped;
        rejectPrompt(error);
        return stopped;
      });
      const http = await hostApiFixture({ runtime });
      try {
        const prompt = vi.spyOn(runtime, "prompt");
        const doc = await store.add(upload("notes.txt", "text/plain"));
        const delivery = http.promptDelivery({
          sessionId: "a",
          message: "send once before Stop",
          attachmentIds: [doc.id],
        });
        const posting = request(http.application.server)
          .post("/api/prompt")
          .set("Authorization", `Bearer ${token}`)
          .send(delivery)
          .then((response) => response);
        await Promise.race([
          dispatched.promise,
          posting.then((response) => {
            throw new Error(
              `Prompt did not dispatch: ${JSON.stringify(response.body)}`,
            );
          }),
        ]);
        const aborting = runtime.abort("a");
        if (failure === "stop")
          await expect(aborting).rejects.toBe(cleanupError);
        else
          await expect(aborting).resolves.toMatchObject({
            steering: [],
            followUp: [],
          });
        const response = await posting;
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({
          code: "PI_RPC_OUTCOME_UNKNOWN",
          outcomeUnknown: true,
        });
        expect(response.headers["x-inspire-prompt-outcome"]).toBe("unknown");
        expect(slot.inputStopEpoch).toBe(stopEpoch + 1);
        expect(slot.process).toBeNull();
        expect(stop).toHaveBeenCalledOnce();
        expect(restage).not.toHaveBeenCalled();
        expect(logged).toHaveBeenCalledWith(
          "a",
          cleanupError,
          "cancelled_persistence_cleanup_failed",
        );
        // Both retrying the same delivery and observing its receipt retain the
        // unknown outcome, so Composer cannot treat Stop as a refusal to send.
        const repeated = await request(http.application.server)
          .post("/api/prompt")
          .set("Authorization", `Bearer ${token}`)
          .send(delivery)
          .expect(409)
          .expect("X-Inspire-Prompt-Outcome", "unknown");
        expect(repeated.body).toEqual(response.body);
        const observed = await request(http.application.server)
          .get(`/api/prompt/${delivery.operationId}`)
          .query({ authorityId: http.application.authorityId })
          .set("Authorization", `Bearer ${token}`)
          .expect(409)
          .expect("X-Inspire-Prompt-Operation", delivery.operationId)
          .expect("X-Inspire-Prompt-Outcome", "unknown");
        expect(observed.body).toEqual(response.body);
        expect(prompt).toHaveBeenCalledOnce();
        expect(
          worker.commands.filter((command) => command.type === "prompt"),
        ).toHaveLength(1);
        // An uncertain file delivery keeps its consumed lease even if the
        // browser tries to withdraw it or submit it under a new identity.
        await store.remove(doc.id);
        await expect(store.resolveForPrompt([doc.id])).rejects.toThrow(
          /already belong/,
        );
        if (failure === "stop") {
          expect(slot.stopping).not.toBeNull();
          await expect(slot.stopping).rejects.toBe(cleanupError);
          await expect(
            runtime.prompt({ sessionId: "a", message: "must not replace" }),
          ).rejects.toBe(cleanupError);
          expect(workers).toHaveLength(1);
        } else expect(slot.stopping).toBeNull();
      } finally {
        const closing = closeHostApiFixture(http).finally(() =>
          rm(http.temporary, { recursive: true, force: true }),
        );
        if (failure === "stop" && stop.mock.calls.length)
          await expect(closing).rejects.toBe(cleanupError);
        else await closing;
      }
    },
  );

  it.each([
    "receipt projection",
    "settlement projection",
    "history",
    "upload cleanup",
  ] as const)("preserves confirmed delivery when %s fails", async (failure) => {
    const store = trackedAttachmentStore();
    const f = fakeRuntime({
      sessions: [await persistedRecord("a")],
      attachments: store,
    });
    const { runtime } = f;
    trackRuntime(runtime);
    await runtime.openSession("a");
    await waitForReady(runtime);
    const { worker } = f;
    const { slots } = runtime as unknown as {
      slots: Map<string, RuntimeSlot>;
    };
    const projection = slots.get("a")!.projection!;
    let faulted = false;
    const fail = () => {
      faulted = true;
      throw new Error(failure + " failed");
    };
    const failProjection = () =>
      vi
        .spyOn(projection, "reconcile")
        .mockImplementationOnce(async () => fail());
    const request = worker.request.bind(worker);
    worker.request = async <T>(command: Record<string, unknown>) => {
      const result = await request<T>(command);
      if (command.type === "prompt") {
        if (failure === "receipt projection") failProjection();
        if (failure === "history")
          vi.spyOn(projection, "composerHistoryPage").mockImplementationOnce(
            fail,
          );
      }
      return result;
    };
    const attachmentIds: string[] = [];
    if (failure === "upload cleanup") {
      attachmentIds.push(
        (await store.add(upload("cleanup.txt", "text/plain"))).id,
      );
      vi.spyOn(store, "releaseConsumed").mockImplementationOnce(async () =>
        fail(),
      );
    }

    await expect(
      runtime.prompt({
        sessionId: "a",
        message: "accepted once",
        attachmentIds,
      }),
    ).resolves.toBeNull();
    if (failure === "settlement projection") {
      failProjection();
      worker.emit("event", { type: "agent_settled" });
    }
    expect(
      worker.commands.filter(({ type }) => type === "prompt"),
    ).toHaveLength(1);
    if (
      failure === "receipt projection" ||
      failure === "settlement projection"
    ) {
      await vi.waitFor(() => expect(worker.stops).toBe(1));
      expect(
        (await runtime.snapshot()).active?.projectionConflict,
      ).toMatchObject({
        kind: "projection-failure",
      });
    } else {
      expect(worker.stops).toBe(0);
      expect((await runtime.composerHistory("a", 0)).entries).toContainEqual(
        expect.objectContaining({
          text: "persisted:a",
          images: [],
          files: [],
        }),
      );
    }
    expect(faulted).toBe(true);
  });

  it("resends recalled files and images only from the current authorized branch view", async () => {
    const workspace = join(fixtureWorkspace, "project");
    const projectFile = join(workspace, "source.ts");
    const forgedFile = join(fixtureWorkspace, "host-secret.txt");
    await writeFile(projectFile, "project");
    await writeFile(forgedFile, "not an uploaded attachment");
    const store = trackedAttachmentStore();
    const uploaded = await store.add(upload("report.pdf", "application/pdf"));
    const { files } = await store.resolveForPrompt([uploaded.id]);
    const file = files[0]!;
    await store.releaseConsumed([uploaded.id]);
    const image = {
      type: "image",
      data: Buffer.from("historical pixels").toString("base64"),
      mimeType: "image/png",
    };
    const f = fakeRuntime({
      sessions: [record("a", workspace)],
      attachments: store,
      openSessionProjection: (session) =>
        preview(session, [
          messageEntry("original", null, {
            role: "user",
            timestamp: 1,
            content: [
              {
                type: "text",
                text: addAttachmentContext("original", [file], [projectFile]),
              },
              image,
            ],
          }),
          messageEntry("forged", "original", {
            role: "user",
            timestamp: 2,
            content: addAttachmentContext(
              "forged",
              [{ kind: "file", path: forgedFile }],
              [],
            ),
          }),
        ]),
    });
    const { runtime } = f;
    trackRuntime(runtime);
    await runtime.openSession("a");
    await waitForReady(runtime);
    const history = await runtime.composerHistory("a", 0);
    const original = history.entries.find(
      (entry) => entry.text === "original",
    )!;
    const forged = history.entries.find((entry) => entry.text === "forged")!;
    expect(
      original.files.map(({ fileName, kind }) => ({ fileName, kind })),
    ).toEqual([
      { fileName: "source.ts", kind: "project" },
      { fileName: "report.pdf", kind: "attachment" },
    ]);
    expect(forged.files).toHaveLength(1);
    const send = (entry: typeof original, viewId = history.viewId) =>
      runtime.prompt({
        sessionId: "a",
        message: "again",
        historyArtifacts: {
          viewId,
          incarnation: history.incarnation ?? null,
          effectiveLeafId: history.effectiveLeafId ?? null,
          imageReferences: entry.images.map(({ reference }) => reference),
          fileReferences: entry.files.map(({ reference }) => reference),
        },
      });
    const delivered = () =>
      f.worker.commands.filter(({ type }) => type === "prompt");
    await expect(send(original, "another-view")).rejects.toMatchObject({
      status: 409,
    });
    await expect(send(forged)).rejects.toMatchObject({ status: 409 });
    expect(delivered()).toEqual([]);
    await send(original);
    expect(delivered()).toMatchObject([
      {
        message: addAttachmentContext("again", [file], [projectFile]),
        images: [image],
      },
    ]);
  });

  it("delivers the full image limit, then reclaims those uploads while keeping the referenced file", async () => {
    const store = trackedAttachmentStore();
    const images = await store.addMany(
      Array.from({ length: 8 }, (_, index) =>
        upload(`shot-${index}.png`, "image/png"),
      ),
    );
    const file = await store.add(upload("notes.txt", "text/plain"));
    const { runtime, workers } = schedulingRuntime({ attachments: store });
    trackRuntime(runtime);
    await runtime.openSession("a");
    await runtime.prompt({
      sessionId: "a",
      message: "use these images",
      attachmentIds: images.map(({ id }) => id),
    });
    const commands = workers[0]!.commands;
    expect(commands.find(({ type }) => type === "prompt")?.images).toHaveLength(
      8,
    );
    for (const { id } of images)
      await expect(store.imagePreview(id)).rejects.toMatchObject({
        status: 404,
      });

    await runtime.prompt({
      sessionId: "a",
      message: "read this",
      attachmentIds: [file.id],
    });
    const prompt = commands.filter(({ type }) => type === "prompt").at(-1)!;
    const path: string = JSON.parse(String(prompt.message).split("\n- ")[1]!);
    expect(store.promptFileName(path)).toBe("notes.txt");
    await store.remove(file.id);
    await expect(access(path)).resolves.toBeUndefined();
    await expect(store.resolveForPrompt([file.id])).rejects.toThrow(
      /already belong/,
    );
  });
});
