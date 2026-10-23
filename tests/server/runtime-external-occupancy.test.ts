import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PiActivityRecord,
  piActivityProcessIdentity,
} from "../../extensions/inspire-session-bridge.js";
import { HerdrNativeSession } from "../../server/herdr-native-session.js";
import { captureHerdrHostIdentity } from "../../server/herdr-process-group.js";
import type { PiRpcProcess } from "../../server/pi-rpc.js";
import { PiSessionOccupancy } from "../../server/pi-session-occupancy.js";
import { requestError } from "../../server/request-error.js";
import { RuntimeController } from "../../server/runtime.js";
import {
  catalog,
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  initializeRuntimeFixture,
  persistedRecord,
  trackedAttachmentStore,
  waitForReady,
} from "./fixtures/runtime.js";

let directory: string;
beforeEach(async () => {
  await initializeRuntimeFixture();
  directory = await mkdtemp(join(tmpdir(), "inspire-runtime-occupancy-"));
});
afterEach(async () => {
  await disposeRuntimeFixture();
  await rm(directory, { recursive: true, force: true });
});

async function fixture(activity: PiActivityRecord["activity"] = "idle") {
  const session = await persistedRecord("external-session");
  const report = {
    version: 1 as const,
    pid: process.pid,
    processIdentity: await piActivityProcessIdentity(process.pid),
    sessionId: session.id,
    sessionFile: session.path,
    activity,
    updatedAt: Date.now(),
  };
  const file = join(directory, `${process.pid}-${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(report));
  const workers: FakeRpc[] = [];
  const create = vi.fn((options) => {
    const worker = new FakeRpc(options);
    workers.push(worker);
    return worker as unknown as PiRpcProcess;
  });
  const guard = new PiSessionOccupancy(directory);
  const check = vi.fn((id: string, path: string) =>
    guard.assertWritable(id, path),
  );
  const source = catalog([session]);
  const runtime = new RuntimeController(
    source,
    trackedAttachmentStore(),
    create,
  )
    .setExternalSessionConnector(async () => null)
    .setExternalSessionGuard(check);
  return {
    session,
    report,
    file,
    runtime,
    create,
    check,
    workers,
    guard,
    source,
  };
}

describe("writer admission for externally held session files", () => {
  it.skipIf(process.platform !== "linux")(
    "retires an established native connection only after its exact reporter completes a rebind",
    async () => {
      const f = await fixture();
      const replacement = await persistedRecord("replacement-session");
      const identity = await captureHerdrHostIdentity();
      const agent = {
        agent: "pi",
        pane_id: "pane",
        agent_status: "idle",
        agent_session: {
          source: "herdr:pi",
          agent: "pi",
          kind: "id",
          value: f.session.id,
        },
      };
      const read = vi.fn(async () => ({ agent }));
      const native = new HerdrNativeSession(
        {
          nativeAgentRequest: read,
          inspectPaneProcess: async () => ({
            paneId: "pane",
            foregroundProcessGroupId: identity.pid,
            foregroundProcesses: [
              { pid: identity.pid, name: "pi", argv: ["pi"] },
            ],
          }),
        },
        {
          serverId: "server",
          paneId: "pane",
          pid: identity.pid,
          processIdentity: identity,
        },
        f.session.id,
        f.session.path,
        await f.guard.observeBinding(
          identity.pid,
          f.session.id,
          f.session.path,
        ),
      );
      const close = vi.spyOn(native, "close");
      const connector = vi.fn(async () =>
        agent.agent_session.value === f.session.id ? native : null,
      );
      f.runtime.setExternalSessionConnector(connector);
      try {
        f.runtime.retainSessionView(f.session.id);
        await f.runtime.openSession(f.session.id);
        await vi.waitFor(() => expect(read).toHaveBeenCalled());
        expect(f.create).not.toHaveBeenCalled();
        agent.agent_session.value = replacement.id;
        // Herdr's changed session and a live PID are not a completed handoff.
        await vi.waitFor(async () =>
          expect((await f.runtime.snapshot()).active?.readOnlyReason).toBe(
            "external-unavailable",
          ),
        );
        expect(f.create).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        await rm(f.file);
        expect((await f.runtime.snapshot()).active?.readOnlyReason).toBe(
          "external-unavailable",
        );
        await writeFile(
          f.file,
          JSON.stringify({
            ...f.report,
            sessionId: replacement.id,
            sessionFile: replacement.path,
          }),
        );
        // An independent holder of A must still fence normal occupancy admission.
        const second = join(directory, `${process.pid}-${randomUUID()}.json`);
        await writeFile(second, JSON.stringify(f.report));
        await vi.waitFor(
          async () => {
            expect((await f.runtime.snapshot()).active?.readOnlyReason).toBe(
              "external-active",
            );
          },
          { timeout: 5_000 },
        );
        // Retirement is observable without prescribing how many cleanup
        // layers call the idempotent close method.
        const readsBeforeRetiredCheck = read.mock.calls.length;
        await expect(native.read()).resolves.toBeNull();
        expect(read).toHaveBeenCalledTimes(readsBeforeRetiredCheck);
        expect(f.create).not.toHaveBeenCalled();
        await writeFile(
          second,
          JSON.stringify({
            ...f.report,
            sessionId: replacement.id,
            sessionFile: replacement.path,
          }),
        );
        await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce(), {
          timeout: 5_000,
        });
        await waitForReady(f.runtime, f.session.id);
        expect(
          (await f.runtime.snapshot()).active?.readOnlyReason,
        ).toBeUndefined();
      } finally {
        await f.runtime.close();
      }
    },
    15_000,
  );

  it.each(["working", "blocked", "idle"] as const)(
    "opens a reported %s Pi read-only without starting another process",
    async (activity) => {
      const f = await fixture(activity);
      try {
        await f.runtime.openSession(f.session.id);
        await vi.waitFor(async () => {
          const snapshot = await f.runtime.snapshot(f.session.id);
          expect(snapshot.active?.readOnlyReason).toBe("external-active");
          expect(snapshot.active?.sessionFile).toBe(f.session.path);
        });
        await expect(
          f.runtime.prompt({
            sessionId: f.session.id,
            message: "Do not duplicate",
          }),
        ).rejects.toMatchObject({
          status: 409,
          code: "EXTERNAL_PI_WRITER_ACTIVE",
        });
        expect(f.create).not.toHaveBeenCalled();
      } finally {
        await f.runtime.close();
      }
    },
  );

  it("fences a cold writer-backed settings mutation without opening the session", async () => {
    const f = await fixture();
    try {
      await f.runtime.snapshot(f.session.id);
      await expect(
        f.runtime.setModel(f.session.id, "test", "model"),
      ).rejects.toMatchObject({
        status: 409,
        code: "EXTERNAL_PI_WRITER_ACTIVE",
      });
      expect(f.create).not.toHaveBeenCalled();
    } finally {
      await f.runtime.close();
    }
  });

  it("retains report-loss and teardown fences, then automatically recovers the viewed session after rebind", async () => {
    const f = await fixture();
    f.runtime.retainSessionView(f.session.id);
    try {
      await f.runtime.openSession(f.session.id);
      await vi.waitFor(async () =>
        expect((await f.runtime.snapshot()).active?.readOnlyReason).toBe(
          "external-active",
        ),
      );
      await rm(f.file);
      await f.runtime.openSession(f.session.id);
      expect((await f.runtime.snapshot()).active?.readOnlyReason).toBe(
        "external-active",
      );
      expect(f.create).not.toHaveBeenCalled();
      await mkdir(directory, { recursive: true });
      await writeFile(f.file, JSON.stringify({ ...f.report, released: true }));
      await f.runtime.openSession(f.session.id);
      expect((await f.runtime.snapshot()).active?.readOnlyReason).toBe(
        "external-active",
      );
      expect(f.create).not.toHaveBeenCalled();
      // A browser still viewing this session does not depend on the Host's
      // global selection (another browser may have left it).
      await f.runtime.deselectSession();
      await writeFile(
        f.file,
        JSON.stringify({
          ...f.report,
          sessionId: "replacement",
          sessionFile: join(directory, "replacement.jsonl"),
        }),
      );
      await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce(), {
        timeout: 5_000,
      });
      await waitForReady(f.runtime, f.session.id);
      expect(
        (await f.runtime.snapshot(f.session.id)).active?.readOnlyReason,
      ).toBeUndefined();
      expect(f.runtime.activeSessionId).toBeNull();
      expect(f.create).toHaveBeenCalledOnce();
      expect(f.workers[0]!.starts).toBe(1);
    } finally {
      await f.runtime.close();
    }
  });

  it("shares quiet observation retries and resumes when an abandoned view is subscribed again", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const release = f.runtime.retainSessionView(f.session.id);
    const stillViewed = f.runtime.retainSessionView(f.session.id);
    const events: unknown[] = [];
    f.runtime.on("event", (event) => events.push(event));
    const entered = deferredSignal();
    const proceed = deferredSignal();
    try {
      await f.runtime.openSession(f.session.id);
      await vi.waitFor(async () =>
        expect((await f.runtime.snapshot()).active?.readOnlyReason).toBe(
          "external-active",
        ),
      );
      release(); // Another browser still owns the same observation.
      f.check.mockRejectedValue(new Error("Presence temporarily unavailable"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await f.runtime.snapshot()).active?.readOnlyReason).toBe(
        "external-unavailable",
      );
      const before = events.length;
      const checks = f.check.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.check.mock.calls.length).toBeGreaterThan(checks);
      expect(events).toHaveLength(before);
      expect(f.create).not.toHaveBeenCalled();
      f.check.mockImplementationOnce(async () => {
        entered.resolve();
        await proceed.promise;
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await entered.promise;
      stillViewed();
      proceed.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.create).not.toHaveBeenCalled();
      expect((await f.runtime.snapshot()).active?.readOnlyReason).toBe(
        "external-unavailable",
      );
      const abandonedChecks = f.check.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.check).toHaveBeenCalledTimes(abandonedChecks);

      f.check.mockResolvedValue();
      f.runtime.retainSessionView(f.session.id);
      await vi.advanceTimersByTimeAsync(2_000);
      await waitForReady(f.runtime, f.session.id);
      expect(f.create).toHaveBeenCalledOnce();
      expect(
        (await f.runtime.snapshot()).active?.readOnlyReason,
      ).toBeUndefined();
    } finally {
      proceed.resolve();
      stillViewed();
      await f.runtime.close();
      vi.useRealTimers();
    }
  });

  it("retains recovery through failed preparation until the writer is ready", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.runtime.retainSessionView(f.session.id);
    f.create.mockImplementationOnce(() => {
      throw new Error("Worker preparation temporarily unavailable");
    });
    try {
      await f.runtime.openSession(f.session.id);
      await vi.waitFor(async () =>
        expect((await f.runtime.snapshot()).active?.readOnlyReason).toBe(
          "external-active",
        ),
      );
      const before = (await f.runtime.snapshot()).active!;
      f.check.mockResolvedValue();
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce());
      expect((await f.runtime.snapshot()).active?.readOnlyReason).toBe(
        "external-active",
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await waitForReady(f.runtime, f.session.id);
      const recovered = (await f.runtime.snapshot()).active!;
      expect(recovered.readOnlyReason).toBeUndefined();
      expect(recovered.transcriptPage.viewId).toBe(
        before.transcriptPage.viewId,
      );
      expect(
        f.workers[0]!.commands.some((command) => command.type === "prompt"),
      ).toBe(false);
    } finally {
      await f.runtime.close();
      vi.useRealTimers();
    }
  });

  it.each(["start", "attestation"] as const)(
    "reports an actual Pi %s failure without automatically restarting it",
    async (phase) => {
      const f = await fixture();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      f.runtime.retainSessionView(f.session.id);
      f.create.mockImplementationOnce((options) => {
        const worker = new FakeRpc(options);
        if (phase === "start")
          vi.spyOn(worker, "start").mockRejectedValue(
            new Error("Pi failed during session_start"),
          );
        else
          worker.responseOverrides.set("get_state", () => {
            throw new Error("Startup attestation unavailable");
          });
        f.workers.push(worker);
        return worker as unknown as PiRpcProcess;
      });
      try {
        await f.runtime.openSession(f.session.id);
        await vi.waitFor(async () =>
          expect((await f.runtime.snapshot()).active?.readOnlyReason).toBe(
            "external-active",
          ),
        );
        f.check.mockResolvedValue();
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.waitFor(() => expect(f.workers[0]?.stops).toBe(1));
        const failed = await f.runtime.snapshot();
        expect(failed.runState).toBe("failed");
        expect(failed.active?.readOnlyReason).toBeUndefined();
        await vi.advanceTimersByTimeAsync(6_000);
        expect(f.create).toHaveBeenCalledOnce();

        await f.runtime.openSession(f.session.id);
        await waitForReady(f.runtime, f.session.id);
        expect(f.workers[1]!.starts).toBe(1);
      } finally {
        await f.runtime.close();
        vi.useRealTimers();
      }
    },
  );

  it("pauses admission during deletion and resumes observation if deletion fails", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.runtime.retainSessionView(f.session.id);
    const entered = deferredSignal();
    const proceed = deferredSignal();
    try {
      await f.runtime.openSession(f.session.id);
      await vi.waitFor(async () =>
        expect((await f.runtime.snapshot()).active?.readOnlyReason).toBe(
          "external-active",
        ),
      );
      vi.spyOn(f.source, "get").mockImplementationOnce(async () => {
        entered.resolve();
        await proceed.promise;
        throw new Error("Catalog temporarily unavailable");
      });
      const deleting = f.runtime
        .deleteSession(f.session.id)
        .catch((error: unknown) => error);
      await entered.promise;
      f.check.mockResolvedValue();
      const checks = f.check.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.check).toHaveBeenCalledTimes(checks);
      expect(f.create).not.toHaveBeenCalled();
      proceed.resolve();
      expect(await deleting).toMatchObject({
        message: "Catalog temporarily unavailable",
      });

      await vi.advanceTimersByTimeAsync(2_000);
      await waitForReady(f.runtime, f.session.id);
      expect(f.create).toHaveBeenCalledOnce();
      expect(
        (await f.runtime.snapshot()).active?.readOnlyReason,
      ).toBeUndefined();
    } finally {
      proceed.resolve();
      await f.runtime.close();
      vi.useRealTimers();
    }
  });

  it("keeps supported Herdr native control without launching a local writer", async () => {
    const f = await fixture();
    const native = {
      read: async () => ({ status: "idle" as const }),
      prompt: vi.fn(async () => {}),
      abort: async () => {},
      close: () => {},
    };
    f.runtime.setExternalSessionConnector(async () => native);
    try {
      await f.runtime.openSession(f.session.id);
      await f.runtime.prompt({
        sessionId: f.session.id,
        message: "Continue in the native terminal",
      });
      expect(native.prompt).toHaveBeenCalledOnce();
      expect(f.check).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
    } finally {
      await f.runtime.close();
    }
  });

  it("preserves the reading view when pre-start admission is refused and later recovers", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.check.mockResolvedValueOnce();
    f.check.mockRejectedValue(
      requestError("External Pi acquired the session", 409, {
        code: "EXTERNAL_PI_WRITER_ACTIVE",
      }),
    );
    const events: Array<{ type: string }> = [];
    f.runtime.on("event", (event) => events.push(event));
    try {
      f.runtime.retainSessionView(f.session.id);
      const before = (await f.runtime.snapshot(f.session.id)).active!;
      await f.runtime.openSession(f.session.id);
      await vi.waitFor(() => expect(f.workers[0]?.stops).toBe(1));
      const blocked = (await f.runtime.snapshot()).active!;
      expect(blocked.readOnlyReason).toBe("external-active");
      expect(f.workers[0]!.starts).toBe(0);
      expect(blocked.transcriptPage.viewId).toBe(before.transcriptPage.viewId);
      expect(blocked.transcriptPage.messages).toEqual(
        before.transcriptPage.messages,
      );
      expect(events.some((event) => event.type === "runtime_error")).toBe(
        false,
      );

      f.check.mockResolvedValue();
      await vi.advanceTimersByTimeAsync(2_000);
      await waitForReady(f.runtime, f.session.id);
      expect(f.workers[1]!.starts).toBe(1);
      const recovered = (await f.runtime.snapshot()).active!;
      expect(recovered.readOnlyReason).toBeUndefined();
      expect(recovered.transcriptPage.viewId).toBe(
        before.transcriptPage.viewId,
      );
    } finally {
      await f.runtime.close();
      vi.useRealTimers();
    }
  });
});
