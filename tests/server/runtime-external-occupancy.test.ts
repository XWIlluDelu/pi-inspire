import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  piActivityProcessIdentity,
  type PiActivityRecord,
} from "../../docs/examples/session-activity.js";
import { PiSessionOccupancy } from "../../server/pi-session-occupancy.js";
import type { PiRpcProcess } from "../../server/pi-rpc.js";
import { requestError } from "../../server/request-error.js";
import { RuntimeController } from "../../server/runtime.js";
import {
  catalog,
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
  const runtime = new RuntimeController(
    catalog([session]),
    trackedAttachmentStore(),
    create,
  )
    .setExternalSessionConnector(async () => null)
    .setExternalSessionGuard(check);
  return { session, report, file, runtime, create, check, workers };
}

describe("writer admission for externally held session files", () => {
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

  it("retains the fence on report loss and teardown hints, allowing reopen after completed rebind", async () => {
    const f = await fixture();
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
      await writeFile(
        f.file,
        JSON.stringify({
          ...f.report,
          sessionId: "replacement",
          sessionFile: join(directory, "replacement.jsonl"),
        }),
      );
      // A previous selection's background check may still be unwinding.
      // Explicit reselection must eventually observe the completed rebind.
      await vi.waitFor(async () => {
        await f.runtime.openSession(f.session.id);
        expect(
          (await f.runtime.snapshot()).active?.readOnlyReason,
        ).toBeUndefined();
      });
      await waitForReady(f.runtime, f.session.id);
      expect(
        (await f.runtime.snapshot()).active?.readOnlyReason,
      ).toBeUndefined();
      expect(f.create).toHaveBeenCalledOnce();
      expect(f.workers[0]!.starts).toBe(1);
    } finally {
      await f.runtime.close();
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

  it("rechecks after asynchronous startup preparation before starting Pi", async () => {
    const f = await fixture();
    f.check.mockResolvedValueOnce();
    f.check.mockRejectedValue(
      requestError("External Pi acquired the session", 409, {
        code: "EXTERNAL_PI_WRITER_ACTIVE",
      }),
    );
    try {
      await f.runtime.openSession(f.session.id);
      await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce());
      await vi.waitFor(async () =>
        expect((await f.runtime.snapshot()).active?.readOnlyReason).toBe(
          "external-active",
        ),
      );
      expect(f.workers[0]!.starts).toBe(0);
    } finally {
      await f.runtime.close();
    }
  });
});
