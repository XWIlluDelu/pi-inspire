import { appendFile, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExternalSessionConnection,
  ExternalSessionState,
} from "../../server/external-session.js";
import type { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import {
  catalog,
  deferredSignal,
  disposeRuntimeFixture,
  FakeRpc,
  initializeRuntimeFixture,
  persistedRecord,
  preview,
  record,
  trackedAttachmentStore,
} from "./fixtures/runtime.js";

beforeEach(initializeRuntimeFixture);
afterEach(disposeRuntimeFixture);

function nativeFixture() {
  let state: ExternalSessionState | null = { status: "idle" };
  const native: ExternalSessionConnection = {
    read: vi.fn(async () => state),
    prompt: vi.fn(async () => {
      state = { status: "working" };
    }),
    abort: vi.fn(async () => {
      state = { status: "idle" };
    }),
    close: vi.fn(),
  };
  return {
    native,
    setState: (next: ExternalSessionState | null) => {
      state = next;
    },
  };
}

describe("continue a Pi already running in a terminal", () => {
  it("opens, prompts, stops and renames the existing Pi without starting a worker", async () => {
    const f = nativeFixture();
    const create = vi.fn(
      (options) => new FakeRpc(options) as unknown as PiRpcProcess,
    );
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      create,
      preview,
    ).setExternalSessionConnector(async () => f.native);
    try {
      await runtime.openSession("a");
      await runtime.prompt({ sessionId: "a", message: "Continue here" });
      expect(f.native.prompt).toHaveBeenCalledWith(
        "Continue here",
        undefined,
        expect.any(Function),
      );
      expect(create).not.toHaveBeenCalled();
      await vi.waitFor(
        async () =>
          expect((await runtime.snapshot("a")).runState).toBe("running"),
        { timeout: 2000 },
      );
      await runtime.abort("a");
      expect(f.native.abort).toHaveBeenCalledOnce();
      await runtime.rename("a", "Understanding");
      expect(f.native.prompt).toHaveBeenLastCalledWith(
        "/name Understanding",
        undefined,
        expect.any(Function),
      );
    } finally {
      await runtime.close();
    }
    expect(f.native.close).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not block Host restart for independently running Pi work", async () => {
    const f = nativeFixture();
    f.setState({ status: "working" });
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      () => {
        throw new Error("must not launch Pi");
      },
      preview,
    ).setExternalSessionConnector(async () => f.native);
    try {
      await runtime.openSession("a");
      await vi.waitFor(async () =>
        expect((await runtime.snapshot()).runState).toBe("running"),
      );
      expect(runtime.reserveMaintenanceRestart()).toMatchObject({
        kind: "ready",
      });
    } finally {
      await runtime.close();
    }
    expect(f.native.abort).not.toHaveBeenCalled();
    expect(f.native.close).toHaveBeenCalledOnce();
  });

  it("keeps simultaneous warmup and prompt on one connection and retains addressed selection", async () => {
    const f = nativeFixture();
    const gate = deferredSignal();
    const connect = vi.fn(async (id: string) => {
      if (id === "a") {
        await gate.promise;
        return f.native;
      }
      return null;
    });
    const workers: FakeRpc[] = [];
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp"), record("b", "/tmp")]),
      trackedAttachmentStore(),
      (options) => {
        const worker = new FakeRpc(options);
        workers.push(worker);
        return worker as unknown as PiRpcProcess;
      },
      preview,
    ).setExternalSessionConnector(connect);
    try {
      await runtime.openSession("a");
      const sending = runtime.prompt({ sessionId: "a", message: "For A only" });
      await runtime.openSession("b");
      gate.resolve();
      await sending;
      expect(connect.mock.calls.filter(([id]) => id === "a")).toHaveLength(1);
      expect(runtime.activeSessionId).toBe("b");
      expect(workers.every((worker) => worker.sessionId === "b")).toBe(true);
      expect(f.native.prompt).toHaveBeenCalledWith(
        "For A only",
        undefined,
        expect.any(Function),
      );
    } finally {
      gate.resolve();
      await runtime.close();
    }
  });

  it("displays native history appends without claiming another writer or losing the connection", async () => {
    const session = await persistedRecord("a");
    const f = nativeFixture();
    const runtime = new RuntimeController(
      catalog([session]),
      trackedAttachmentStore(),
      () => {
        throw new Error("must not launch Pi");
      },
    ).setExternalSessionConnector(async () => f.native);
    try {
      await runtime.openSession("a");
      await runtime.prompt({ sessionId: "a", message: "Continue" });
      const entries = (await readFile(session.path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      await appendFile(
        session.path,
        JSON.stringify({
          type: "message",
          id: "native-reply",
          parentId: entries.at(-1).id,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Reply from the same Pi" }],
            timestamp: Date.now(),
          },
        }) + "\n",
      );
      const snapshot = await runtime.snapshot("a");
      expect(snapshot.active?.projectionConflict).toBeNull();
      expect(
        JSON.stringify(snapshot.active?.transcriptPage.messages),
      ).toContain("Reply from the same Pi");
      expect(f.native.close).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("passes files through native input and retains their bytes for the existing process", async () => {
    const store = trackedAttachmentStore();
    const uploaded = await store.add({
      originalname: "notes.txt",
      mimetype: "text/plain",
      size: 5,
      buffer: Buffer.from("notes"),
    } as Express.Multer.File);
    const f = nativeFixture();
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      store,
      () => {
        throw new Error("must not launch Pi");
      },
      preview,
    ).setExternalSessionConnector(async () => f.native);
    try {
      await runtime.openSession("a");
      await runtime.prompt({
        sessionId: "a",
        message: "Read this",
        attachmentIds: [uploaded.id],
      });
      const text = vi.mocked(f.native.prompt).mock.calls[0]![0];
      expect(text).toContain("Read this");
      expect(text).toContain("Referenced files available");
      const paths = store.referencedPromptFiles(text);
      expect(paths).toHaveLength(1);
      expect(await readFile(paths[0]!, "utf8")).toBe("notes");
    } finally {
      await runtime.close();
    }
  });

  it("does not deliver a prepared message after Stop and admits a genuinely new send", async () => {
    const f = nativeFixture();
    const entered = deferredSignal();
    const gate = deferredSignal();
    const delivered: string[] = [];
    vi.mocked(f.native.prompt)
      .mockImplementationOnce(async (text, _behavior, beforeSend) => {
        entered.resolve();
        await gate.promise;
        beforeSend?.();
        delivered.push(text);
      })
      .mockImplementation(async (text, _behavior, beforeSend) => {
        beforeSend?.();
        delivered.push(text);
      });
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      () => {
        throw new Error("must not launch Pi");
      },
      preview,
    ).setExternalSessionConnector(async () => f.native);
    try {
      await runtime.openSession("a");
      const sending = runtime
        .prompt({ sessionId: "a", message: "Stopped input" })
        .catch((error) => error);
      await entered.promise;
      await runtime.abort("a");
      gate.resolve();
      expect(await sending).toMatchObject({ status: 409 });
      expect(delivered).toEqual([]);
      await runtime.prompt({ sessionId: "a", message: "Fresh input" });
      expect(delivered).toEqual(["Fresh input"]);
    } finally {
      gate.resolve();
      await runtime.close();
    }
  });

  it("closes only its connection while discovery is in flight", async () => {
    const f = nativeFixture();
    const gate = deferredSignal();
    const runtime = new RuntimeController(
      catalog([record("a", "/tmp")]),
      trackedAttachmentStore(),
      () => {
        throw new Error("must not launch Pi after close");
      },
      preview,
    ).setExternalSessionConnector(async () => {
      await gate.promise;
      return f.native;
    });
    await runtime.openSession("a");
    const closing = runtime.close();
    gate.resolve();
    await closing;
    expect(f.native.close).toHaveBeenCalledOnce();
    expect(f.native.prompt).not.toHaveBeenCalled();
  });
});
