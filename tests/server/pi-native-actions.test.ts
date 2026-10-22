import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import reportActivity, {
  NATIVE_MODEL_READ_TIMEOUT_MS,
  type NativeActionRequest,
  nativeActionFrame,
  nativeActionPath,
  type PiActivityRecord,
  piActivityDirectory,
  piActivityProcessIdentity,
} from "../../docs/examples/session-activity.js";
import { PiNativeActions } from "../../server/pi-native-actions.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "inspire-native-actions-unit-"),
  );
  directories.push(directory);
  const sessionFile = join(directory, "session.jsonl");
  await writeFile(sessionFile, "");
  const receiverId = randomUUID(),
    report = join(directory, process.pid + "-" + randomUUID() + ".json");
  const record: PiActivityRecord = {
    version: 1,
    pid: process.pid,
    processIdentity: await piActivityProcessIdentity(process.pid),
    sessionId: "one",
    sessionFile,
    activity: "idle",
    updatedAt: Date.now(),
    nativeActions: { version: 2, receiverId },
  };
  const publish = () => writeFile(report, JSON.stringify(record));
  await publish();
  const actions = new PiNativeActions(
    process.pid,
    "one",
    sessionFile,
    record.processIdentity,
    directory,
  );
  const payload = async () => {
    const [name] = await readdir(join(directory, "actions"));
    return JSON.parse(
      await readFile(join(directory, "actions", name!), "utf8"),
    ) as NativeActionRequest;
  };
  return { actions, record, directory, receiverId, publish, payload };
}

it.each(["missing", "process", "file", "ambiguous"] as const)(
  "requires one exact live action receiver (%s)",
  async (change) => {
    const f = await fixture(),
      send = vi.fn();
    if (change === "missing") delete f.record.nativeActions;
    if (change === "process") f.record.pid += 1;
    if (change === "file")
      f.record.sessionFile = join(f.directory, "other.jsonl");
    if (change === "ambiguous")
      await writeFile(
        join(f.directory, process.pid + "-" + randomUUID() + ".json"),
        JSON.stringify(f.record),
      );
    await f.publish();
    await expect(
      f.actions.invoke({ type: "abort" }, send),
    ).rejects.toMatchObject({ code: "NATIVE_ACTIONS_UNAVAILABLE" });
    expect(send).not.toHaveBeenCalled();
  },
);

it.each(["invoked", "rejected"] as const)(
  "consumes only the matched native %s receipt and removes transport data",
  async (status) => {
    const f = await fixture();
    const send = vi.fn(async (frame: string) => {
      const request = await f.payload();
      expect(frame).toBe(nativeActionFrame(f.receiverId, request.operationId));
      expect(request).toMatchObject({
        sessionId: "one",
        pid: process.pid,
        action: { type: "prompt", message: "hello" },
      });
      request.result = {
        operationId: request.operationId,
        status,
        code: "NATIVE_INPUT_BLOCKED",
        message: "Answer the native dialog",
      };
      await writeFile(
        nativeActionPath(f.directory, request.operationId),
        JSON.stringify(request),
      );
    });
    const result = f.actions.invoke({ type: "prompt", message: "hello" }, send);
    if (status === "invoked") await expect(result).resolves.toBeUndefined();
    else
      await expect(result).rejects.toMatchObject({
        status: 409,
        code: "NATIVE_INPUT_BLOCKED",
      });
    expect(send).toHaveBeenCalledOnce();
    expect(await readdir(join(f.directory, "actions"))).toEqual([]);
  },
);

it.each(["timeout", "abandoned", "reload"] as const)(
  "cancels a slow native directory read on %s without publishing a late catalog",
  async (cause) => {
    const root = await mkdtemp(join(tmpdir(), "inspire-native-catalog-"));
    directories.push(root);
    vi.stubEnv("XDG_CACHE_HOME", root);
    vi.stubEnv("LOCALAPPDATA", root);
    vi.stubEnv("HERDR_ENV", "1");
    vi.stubEnv("HERDR_PANE_ID", "fixture");
    vi.stubEnv("HERDR_SOCKET_PATH", join(root, "unused"));
    const sessionFile = join(root, "session.jsonl");
    await writeFile(sessionFile, "");
    const handlers = new Map<
      string,
      (event: unknown, ctx: ExtensionContext) => Promise<void>
    >();
    let receive!: (frame: string) => unknown, refreshSignal!: AbortSignal;
    let finishRefresh!: () => void;
    const refresh = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      refreshSignal = signal;
      // A non-cooperative discovery must not delay cancellation or publish later.
      await new Promise<void>((resolve) => {
        finishRefresh = resolve;
      });
    });
    const getAvailable = vi.fn(async () => []);
    const context = {
      mode: "tui",
      cwd: root,
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => "one",
        getSessionFile: () => sessionFile,
      },
      ui: {
        onTerminalInput: (handler: typeof receive) => {
          receive = handler;
          return () => {};
        },
      },
      modelRegistry: { refresh, getAvailable },
    } as unknown as ExtensionContext;
    reportActivity({
      on: (
        name: string,
        handler: (event: unknown, ctx: ExtensionContext) => Promise<void>,
      ) => handlers.set(name, handler),
      getThinkingLevel: () => "off",
    } as unknown as ExtensionAPI);
    const start = () =>
      handlers.get("session_start")!({ reason: "reload" }, context);
    const stop = () =>
      handlers.get("session_shutdown")!({ reason: "reload" }, context);
    const controller = new AbortController();
    try {
      await start();
      const directory = piActivityDirectory();
      const actions = new PiNativeActions(
        process.pid,
        "one",
        sessionFile,
        undefined,
        directory,
      );
      if (cause === "timeout")
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = actions.invoke(
        { type: "get_models" },
        async (frame) => receive(frame),
        undefined,
        controller.signal,
      );
      const rejection = expect(pending).rejects.toThrow(
        cause === "timeout"
          ? "timed out"
          : cause === "abandoned"
            ? "Detached"
            : "could not be confirmed",
      );
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      if (cause === "timeout")
        await vi.advanceTimersByTimeAsync(NATIVE_MODEL_READ_TIMEOUT_MS);
      else if (cause === "abandoned") controller.abort(new Error("Detached"));
      else {
        await stop();
        await start();
      }
      await rejection;
      await vi.waitFor(() => expect(refreshSignal.aborted).toBe(true));
      finishRefresh();
      await Promise.resolve();
      expect(getAvailable).not.toHaveBeenCalled();
      expect(await readdir(join(directory, "actions"))).toEqual([]);
    } finally {
      finishRefresh?.();
      await stop();
    }
  },
);

it("requires the native receiver to support image content before sending references", async () => {
  const f = await fixture(),
    send = vi.fn();
  await expect(
    f.actions.invoke(
      {
        type: "prompt",
        message: "",
        images: [{ path: "/managed/image.png", mimeType: "image/png" }],
      },
      send,
    ),
  ).rejects.toMatchObject({ code: "NATIVE_ACTIONS_UNAVAILABLE" });
  expect(send).not.toHaveBeenCalled();
});

it("requires advertised model controls before sending a catalog invocation", async () => {
  const f = await fixture(),
    send = vi.fn();
  await expect(
    f.actions.invoke({ type: "get_models" }, send),
  ).rejects.toMatchObject({
    code: "NATIVE_ACTIONS_UNAVAILABLE",
  });
  expect(send).not.toHaveBeenCalled();
});

it("does not turn a late receiver rebind into success or retry a mutation", async () => {
  const f = await fixture();
  const send = vi.fn(async () => {
    f.record.sessionId = "other";
    await f.publish();
  });
  await expect(f.actions.invoke({ type: "abort" }, send)).rejects.toMatchObject(
    { code: "PI_RPC_OUTCOME_UNKNOWN", outcomeUnknown: true },
  );
  expect(send).toHaveBeenCalledOnce();
  expect(await readdir(join(f.directory, "actions"))).toEqual([]);
});

it("checks original Stop ownership before emitting a frame", async () => {
  const f = await fixture(),
    send = vi.fn();
  await expect(
    f.actions.invoke({ type: "prompt", message: "old" }, send, () => {
      throw new Error("Stopped before send");
    }),
  ).rejects.toThrow("Stopped before send");
  expect(send).not.toHaveBeenCalled();
  expect(await readdir(join(f.directory, "actions"))).toEqual([]);
});
