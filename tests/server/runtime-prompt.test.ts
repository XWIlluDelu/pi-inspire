import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAttachmentContext } from "../../server/attachments.js";

import {
  PiRpcCancelledError,
  PiRpcOutcomeUnknownError,
  type PiRpcProcess,
} from "../../server/pi-rpc.js";

import { RuntimeController } from "../../server/runtime.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";

import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "./fixtures/host-api.js";
import { PreviewProjection } from "./fixtures/preview-projection.js";
import {
  catalog,
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  initializeRuntimeFixture,
  persistedRecord,
  preview,
  previewSnapshot,
  record,
  schedulingRuntime,
  trackedAttachmentStore,
  upload,
  waitForReady,
  workspaceDirectories,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

describe("prompt admission and artifact ownership", () => {
  it("returns the Pi-file preview before extensions finish and makes prompt await readiness", async () => {
    const store = trackedAttachmentStore();
    const { promise: gate, resolve: release } = deferredSignal();
    const f = schedulingRuntime({
      attachments: store,
      configure: (worker) => {
        worker.startGate = gate;
      },
    });
    const { runtime } = f;

    const opening = runtime.openSession("a");
    await vi.waitFor(() => expect(f.worker?.starts).toBe(1));
    const opened = await opening;
    expect(opened.active?.transcriptPage.messages).toEqual([
      { role: "user", content: "preview:a", timestamp: 1 },
    ]);

    const prompting = runtime.prompt({ sessionId: "a", message: "continue" });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(f.worker.commands.some((command) => command.type === "prompt")).toBe(
      false,
    );
    release();
    await prompting;
    expect(f.worker.commands.some((command) => command.type === "prompt")).toBe(
      true,
    );
    await runtime.close();
  });

  it("revalidates project-file authority after gated worker startup", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "inspire-runtime-project-revalidate-"),
    );
    workspaceDirectories.push(workspace);
    const selected = join(workspace, "selected.txt");
    await writeFile(selected, "selected");
    const store = trackedAttachmentStore();
    const { promise: gate, resolve: release } = deferredSignal();
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([record("a", workspace)]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        worker.startGate = gate;
        return worker as unknown as PiRpcProcess;
      },
      preview,
    );

    try {
      await runtime.openSession("a");
      await vi.waitFor(() => expect(worker.starts).toBe(1));
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

      await rm(selected);
      release();
      await expect(prompting).rejects.toMatchObject({
        status: 409,
        message: "A selected project file changed before prompt delivery",
      });
      expect(worker.commands.some((command) => command.type === "prompt")).toBe(
        false,
      );
    } finally {
      release();
      await runtime.close();
    }
  });

  it("shields prompt attachments from a DELETE racing the gated delivery", async () => {
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
      message: "use the note",
      attachmentIds: [doc.id],
    });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    // The prompt owns the file while delivery waits on the worker; the
    // racing withdrawal must be moot.
    await store.remove(doc.id);
    release();
    await prompting;

    const promptCommand = f.worker.commands.find(
      (command) => command.type === "prompt",
    );
    const referenced = JSON.parse(
      String(promptCommand?.message ?? "").split("\n- ")[1]!,
    ) as string;
    expect(referenced).toContain("notes.txt");
    await expect(access(referenced)).resolves.toBeUndefined();
    // Consumed after delivery: a late DELETE is equally moot.
    await store.remove(doc.id);
    await expect(access(referenced)).resolves.toBeUndefined();
    await runtime.close();
  });

  it("rejects a prompt reusing an in-flight attachment without breaking the first lease", async () => {
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
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
      preview,
    );
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
      let worker!: FakeRpc;
      const runtime = new RuntimeController(
        catalog([await persistedRecord("a")]),
        store,
        (options) => {
          worker = new FakeRpc(options);
          const request = worker.request.bind(worker);
          worker.request = async <T>(command: Record<string, unknown>) => {
            if (command.type !== "prompt") return request<T>(command);
            worker.commands.push(command);
            const error = new PiRpcOutcomeUnknownError("prompt");
            error.stopped = confirmed
              ? Promise.resolve()
              : Promise.reject(new Error("Worker exit unconfirmed"));
            throw error;
          };
          if (!confirmed)
            worker.stop = async () => {
              throw new Error("Worker exit unconfirmed");
            };
          return worker as unknown as PiRpcProcess;
        },
      );
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
        worker.commands.filter((command) => command.type === "prompt"),
      ).toHaveLength(1);
      await expect(
        runtime.prompt({
          sessionId: "a",
          message: "do not retry",
          attachmentIds: [doc.id],
        }),
      ).rejects.toThrow(/already belong/);
      expect(
        worker.commands.filter((command) => command.type === "prompt"),
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
      const workers: FakeRpc[] = [];
      const runtime = new RuntimeController(
        catalog([await persistedRecord("a")]),
        store,
        (options) => {
          const worker = new FakeRpc(options);
          workers.push(worker);
          return worker as unknown as PiRpcProcess;
        },
      );
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

  it("acknowledges an accepted prompt when its immediate projection refresh fails", async () => {
    const store = trackedAttachmentStore();
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([await persistedRecord("a")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
    );
    await runtime.openSession("a");
    await waitForReady(runtime);
    const slots = (
      runtime as unknown as {
        slots: Map<
          string,
          {
            projection: {
              reconcile: (force?: boolean) => Promise<unknown>;
            } | null;
          }
        >;
      }
    ).slots;
    const reconcile = vi.spyOn(slots.get("a")!.projection!, "reconcile");
    const request = worker.request.bind(worker);
    worker.request = async <T>(command: Record<string, unknown>) => {
      const result = await request<T>(command);
      if (command.type === "prompt")
        reconcile
          .mockClear()
          .mockRejectedValueOnce(new Error("projection read failed"));
      return result;
    };

    await expect(
      runtime.prompt({ sessionId: "a", message: "accepted once" }),
    ).resolves.toBeNull();
    expect(
      worker.commands.filter((command) => command.type === "prompt"),
    ).toHaveLength(1);
    expect(reconcile).toHaveBeenCalled();
    expect(worker.stops).toBe(1);
    expect((await runtime.snapshot()).active?.projectionConflict).toMatchObject(
      {
        kind: "projection-failure",
      },
    );
    await runtime.close();
  });

  it("does not reject an accepted prompt when optional Composer-history hydration fails", async () => {
    const store = trackedAttachmentStore();
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([await persistedRecord("a")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
    );
    await runtime.openSession("a");
    await waitForReady(runtime);
    const slot = (
      runtime as unknown as {
        slots: Map<
          string,
          {
            projection: {
              composerHistoryPage: (...args: unknown[]) => unknown;
            } | null;
          }
        >;
      }
    ).slots.get("a")!;
    const hydrate = vi.spyOn(slot.projection!, "composerHistoryPage");
    const request = worker.request.bind(worker);
    worker.request = async <T>(command: Record<string, unknown>) => {
      const result = await request<T>(command);
      if (command.type === "prompt")
        hydrate.mockClear().mockImplementation(() => {
          throw new Error("history projection failed");
        });
      return result;
    };

    await expect(
      runtime.prompt({ sessionId: "a", message: "accepted once" }),
    ).resolves.toBeNull();
    expect(
      worker.commands.filter((command) => command.type === "prompt"),
    ).toHaveLength(1);
    expect(hydrate).toHaveBeenCalled();
    hydrate.mockRestore();
    expect((await runtime.composerHistory("a", 0)).entries).toContainEqual(
      expect.objectContaining({ text: "persisted:a", images: [], files: [] }),
    );
    expect(worker.stops).toBe(0);
    await runtime.close();
  });

  it("stops a worker when terminal-event projection reconciliation fails", async () => {
    const store = trackedAttachmentStore();
    let worker!: FakeRpc;
    const runtime = new RuntimeController(
      catalog([await persistedRecord("a")]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
    );
    await runtime.openSession("a");
    await runtime.prompt({ sessionId: "a", message: "accepted" });
    const slot = (
      runtime as unknown as {
        slots: Map<
          string,
          {
            projection: {
              reconcile: (force?: boolean) => Promise<unknown>;
            } | null;
          }
        >;
      }
    ).slots.get("a")!;
    const projection = slot.projection!;
    const reconcile = projection.reconcile.bind(projection);
    projection.reconcile = async () => {
      projection.reconcile = reconcile;
      throw new Error("terminal projection read failed");
    };

    worker.emit("event", { type: "agent_settled" });
    await vi.waitFor(() => expect(worker.stops).toBe(1));
    expect((await runtime.snapshot()).active?.projectionConflict).toMatchObject(
      {
        kind: "projection-failure",
      },
    );
    await runtime.close();
  });

  it("resends all recalled prompt artifacts from the current branch view", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "inspire-history-artifacts-")),
    );
    workspaceDirectories.push(root);
    const workspace = join(root, "project");
    const projectFile = join(workspace, "source.ts");
    await mkdir(workspace);
    await writeFile(projectFile, "project");
    const store = trackedAttachmentStore();
    const uploaded = await store.add(upload("report.pdf", "application/pdf"));
    const leased = await store.resolveForPrompt([uploaded.id]);
    const attachmentFile = leased.files[0]!.path;
    await store.releaseConsumed([uploaded.id]);
    let worker!: FakeRpc;
    const data = Buffer.from("historical pixels").toString("base64");
    const historicalText = addAttachmentContext(
      "original",
      [{ kind: "file", path: attachmentFile }],
      [projectFile],
    );
    const runtime = new RuntimeController(
      catalog([record("a", workspace)]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      async (session) => {
        const value = await previewSnapshot(session);
        return new PreviewProjection(session.id, {
          ...value,
          transcriptPage: {
            ...value.transcriptPage,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: historicalText },
                  { type: "image", data, mimeType: "image/png" },
                ],
                timestamp: 1,
              },
            ],
          },
        });
      },
    );
    await runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    const history = await runtime.composerHistory("a", 0);
    const entry = history.entries[0]!;
    expect(entry.images[0]?.reference).toBe("pi-embedded://0/1");
    expect(entry.files).toEqual([
      {
        reference: "pi-file://0/0",
        fileName: "source.ts",
        kind: "project",
      },
      {
        reference: "pi-file://0/1",
        fileName: "report.pdf",
        kind: "attachment",
      },
    ]);

    await expect(
      runtime.prompt({
        sessionId: "a",
        message: "forged",
        historyArtifacts: {
          viewId: "another-view",
          incarnation: history.incarnation ?? null,
          effectiveLeafId: history.effectiveLeafId ?? null,
          imageReferences: entry.images.map((image) => image.reference),
          fileReferences: entry.files.map((file) => file.reference),
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      worker.commands.filter((command) => command.type === "prompt"),
    ).toEqual([]);

    await runtime.prompt({
      sessionId: "a",
      message: "again",
      historyArtifacts: {
        viewId: history.viewId,
        incarnation: history.incarnation ?? null,
        effectiveLeafId: history.effectiveLeafId ?? null,
        imageReferences: entry.images.map((image) => image.reference),
        fileReferences: entry.files.map((file) => file.reference),
      },
    });
    expect(
      worker.commands.find((command) => command.type === "prompt"),
    ).toMatchObject({
      message: addAttachmentContext(
        "again",
        [{ kind: "file", path: attachmentFile }],
        [projectFile],
      ),
      images: [{ type: "image", data, mimeType: "image/png" }],
    });
    await runtime.close();
  });

  it("rejects a forged recalled attachment path outside the active workspace", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "inspire-forged-history-")),
    );
    workspaceDirectories.push(root);
    const workspace = join(root, "project");
    const forgedFile = join(root, "host-secret.txt");
    await mkdir(workspace);
    await writeFile(forgedFile, "not an uploaded attachment");
    const store = trackedAttachmentStore();
    let worker!: FakeRpc;
    const historicalText = addAttachmentContext(
      "open the report",
      [{ kind: "file", path: forgedFile }],
      [],
    );
    const runtime = new RuntimeController(
      catalog([record("a", workspace)]),
      store,
      (options) => {
        worker = new FakeRpc(options);
        return worker as unknown as PiRpcProcess;
      },
      async (session) => {
        const value = await previewSnapshot(session);
        return new PreviewProjection(session.id, {
          ...value,
          transcriptPage: {
            ...value.transcriptPage,
            messages: [{ role: "user", content: historicalText, timestamp: 1 }],
          },
        });
      },
    );
    await runtime.openSession("a");
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    const history = await runtime.composerHistory("a", 0);
    const entry = history.entries[0]!;
    expect(entry.files).toEqual([
      {
        reference: "pi-file://0/0",
        fileName: "host-secret.txt",
        kind: "attachment",
      },
    ]);

    await expect(
      runtime.prompt({
        sessionId: "a",
        message: "send it again",
        historyArtifacts: {
          viewId: history.viewId,
          incarnation: history.incarnation ?? null,
          effectiveLeafId: history.effectiveLeafId ?? null,
          imageReferences: [],
          fileReferences: entry.files.map((file) => file.reference),
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      worker.commands.filter((command) => command.type === "prompt"),
    ).toHaveLength(0);
    await runtime.close();
  });

  it("does not turn post-acceptance attachment cleanup failure into a rejected prompt", async () => {
    const store = trackedAttachmentStore();
    const attachment = await store.add(upload("cleanup.txt", "text/plain"));
    const cleanup = vi
      .spyOn(store, "releaseConsumed")
      .mockRejectedValue(new Error("Synthetic cleanup failure"));
    const f = schedulingRuntime({ attachments: store });
    const { runtime } = f;
    try {
      await runtime.openSession("a");
      await expect(
        runtime.prompt({
          sessionId: "a",
          message: "accepted synthetic upload",
          attachmentIds: [attachment.id],
        }),
      ).resolves.toBeNull();
      expect(cleanup).toHaveBeenCalled();
      expect(
        f.worker.commands.filter((command) => command.type === "prompt"),
      ).toHaveLength(1);
      expect(f.worker.stops).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("accepts the full image attachment limit without counting RPC image parts twice", async () => {
    const store = trackedAttachmentStore();
    const uploaded = await store.addMany(
      Array.from({ length: 8 }, (_, index) =>
        upload(`shot-${index}.png`, "image/png"),
      ),
    );
    const f = schedulingRuntime({ attachments: store });
    const { runtime } = f;

    await runtime.openSession("a");
    await runtime.prompt({
      sessionId: "a",
      message: "use these images",
      attachmentIds: uploaded.map((item) => item.id),
    });

    const promptCommand = f.worker.commands.find(
      (command) => command.type === "prompt",
    );
    expect(promptCommand?.images).toHaveLength(8);
    await runtime.close();
  });

  it("reclaims consumed image uploads after a delivered prompt but keeps file uploads readable", async () => {
    const store = trackedAttachmentStore();
    const image = await store.add(upload("shot.png", "image/png"));
    const file = await store.add(upload("notes.txt", "text/plain"));
    const f = schedulingRuntime({ attachments: store });
    const { runtime } = f;

    await runtime.openSession("a");
    await runtime.prompt({
      sessionId: "a",
      message: "use these",
      attachmentIds: [image.id, file.id],
    });
    // Image bytes travelled inside the prompt request; the cache entry is gone.
    await expect(store.resolveForPrompt([image.id])).rejects.toThrow(/expired/);
    // The ordinary file's host path is referenced by the conversation text:
    // it stays readable on disk, but cannot join a second message.
    const promptCommand = f.worker.commands.find(
      (command) => command.type === "prompt",
    );
    const referenced = JSON.parse(
      String(promptCommand?.message ?? "").split("\n- ")[1]!,
    ) as string;
    expect(referenced).toContain("notes.txt");
    await expect(access(referenced)).resolves.toBeUndefined();
    await expect(store.resolveForPrompt([file.id])).rejects.toThrow(
      /already belong/,
    );
    await runtime.close();
  });
});
