import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import attachControl, {
  attachControlDirectory,
  requestAttachControl,
} from "../../extensions/attach-control.js";
import {
  AttachControlConnection,
  AttachControlRegistry,
  takeoverCandidate,
} from "../../server/attach-control.js";
import { piInstallation } from "../../server/pi-installation.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import { deleteSessionFile } from "../../server/session-delete.js";
import { savedAssistant } from "../fixtures/history-session.js";
import { hostServices } from "../fixtures/host-services.js";
import { closeHostApiFixture, hostApiFixture } from "./fixtures/host-api.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";
import { writeOfflineModels } from "./fixtures/offline-model.js";
import { upload } from "./fixtures/runtime.js";
import { messageEntry, writeSession } from "./fixtures/session-jsonl.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const NAVIGATE = "tests/fixtures/pi-navigate-extension.ts";
const RELOAD = "tests/fixtures/pi-resource-reload-extension.ts";
const ATTACH_PROMPT = "tests/fixtures/pi-attach-prompt-extension.ts";
const pty = createRequire(import.meta.url)(
  "@lydell/node-pty",
) as typeof import("@lydell/node-pty");

function replacementRuntime({
  registry,
  environment,
  home,
  root,
}: Awaited<ReturnType<typeof attachWorkspace>>) {
  stubNativePiEnvironment(environment);
  cleanup.push(async () => vi.unstubAllEnvs());
  const spawn = vi.fn(() => {
    throw new Error("An external session must reuse its live Pi");
  });
  const services = hostServices(home, { cwd: root, createProcess: spawn });
  const { runtime } = services;
  runtime
    .setExternalSessionPresence((id, file, fresh, isAncestor) =>
      registry.branchLeaves(id, file, { observe: !fresh, isAncestor }),
    )
    .setExternalSessionConnector(async (id, file, match, idleOnly) => {
      const candidate = takeoverCandidate(
        await registry.forSession(id, file),
        match,
        idleOnly,
      );
      return candidate
        ? new AttachControlConnection(registry, candidate)
        : null;
    });
  cleanup.push(() => services.attachments.close());
  cleanup.push(() => runtime.close());
  return { ...services, spawn, cwd: root };
}

async function attachWorkspace(
  env: NodeJS.ProcessEnv = {},
  resume?: { id: string; sessionFile: string },
) {
  const macOS = process.platform === "darwin";
  const settings = {
    defaultProvider: "fixture",
    defaultModel: "offline",
    defaultThinkingLevel: "off",
    defaultProjectTrust: "never",
    enableInstallTelemetry: false,
    retry: { enabled: false },
    compaction: { enabled: false },
  };
  // macOS needs a short home path for the receiver's Unix socket.
  const {
    root: home,
    cwd: root,
    agent,
    sessions,
    env: isolated,
  } = await nativePiWorkspace(
    "pi-ac-",
    settings,
    macOS ? await realpath("/tmp") : tmpdir(),
  );
  cleanup.push(() =>
    rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const runtimeDir = env.XDG_RUNTIME_DIR ?? join(home, "run");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await writeOfflineModels(
    agent,
    "http://127.0.0.1:1/v1",
    "fixture",
    [{ id: "offline", reasoning: true }],
    "$INSPIRE_TEST_ATTACH_API_KEY",
  );
  const id = resume?.id ?? randomUUID();
  const sessionFile = resume?.sessionFile ?? join(sessions, `${id}.jsonl`);
  if (!resume) {
    await writeSession(sessionFile, root, id, [
      messageEntry("u1", null, {
        role: "user",
        content: "first",
        timestamp: 1,
      }),
      messageEntry(
        "a1",
        "u1",
        savedAssistant("answer", {
          provider: "fixture",
          model: "offline",
          timestamp: 2,
        }),
      ),
    ]);
  }
  const environment = {
    ...isolated,
    XDG_RUNTIME_DIR: runtimeDir,
    INSPIRE_TEST_ATTACH_API_KEY: "synthetic",
    ...env,
  };
  const registry = new AttachControlRegistry(
    macOS
      ? join(env.HOME ?? home, "Library", "Caches", "pi-attach-control")
      : join(runtimeDir, "pi-attach-control"),
  );
  return {
    registry,
    id,
    sessionFile,
    home,
    root,
    agent,
    settings,
    environment,
    runtimeDir,
  };
}

/** A real Pi with attach-control loaded. */
async function livePi(
  env: NodeJS.ProcessEnv = {},
  extensions: string[] = [],
  resume?: { id: string; sessionFile: string },
) {
  const fixture = await attachWorkspace(env, resume);
  const { root, environment, sessionFile } = fixture;
  const pi = new PiRpcProcess({
    cwd: root,
    args: [
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-tools",
      "--session",
      sessionFile,
      "--extension",
      resolve("extensions/attach-control.ts"),
      ...extensions.flatMap((path) => ["--extension", resolve(path)]),
    ],
    env: environment,
  });
  cleanup.push(() => pi.stop());
  await pi.start();
  return { ...fixture, pi };
}

async function soleReceiver({
  registry,
  id,
  sessionFile,
}: Awaited<ReturnType<typeof attachWorkspace>>) {
  return vi.waitFor(
    async () => {
      const records = await registry.forSession(id, sessionFile);
      expect(records).toHaveLength(1);
      expect(records[0]?.endpoint).toBeTruthy();
      return records[0]!;
    },
    { timeout: 15_000 },
  );
}

async function holdNativeInput(root: string, name: string) {
  const release = () => writeFile(join(root, `${name}.release`), "");
  cleanup.push(release);
  await vi.waitFor(() => access(join(root, `${name}.entered`)), {
    timeout: 5_000,
  });
  return release;
}

async function attachedHost(
  fixture: Awaited<ReturnType<typeof attachWorkspace>>,
) {
  const services = replacementRuntime(fixture);
  const { runtime, spawn } = services;
  await runtime.openSession(fixture.id);
  const attached = await runtime.takeOverSession(fixture.id);
  expect(spawn).not.toHaveBeenCalled();
  expect(attached.sessionStatuses[fixture.id]?.external).toBe(true);
  const host = await hostApiFixture({ services });
  cleanup.push(() => closeHostApiFixture(host));
  return { ...host, spawn, viewId: attached.active!.transcriptPage.viewId };
}

const UNKNOWN_OUTCOME = "ATTACH_CONTROL_OUTCOME_UNKNOWN";

describe.skipIf(process.platform === "win32")("attach-control in Pi", () => {
  it("observes actual native input, guards queue and Stop, and retains bytes only for an uncertain handoff", async () => {
    const fixture = await livePi({}, [ATTACH_PROMPT]);
    const { pi, root, sessionFile, id, registry } = fixture;
    const connection = new AttachControlConnection(
      registry,
      await soleReceiver(fixture),
    );
    const host = await attachedHost(fixture);
    const address = { sessionId: id, expectedViewId: host.viewId };
    const prompt = (
      message: string,
      options: {
        behavior?: "steer" | "followUp";
        attachmentIds?: string[];
      } = {},
    ) => host.promptDelivery({ ...address, message, ...options });
    const send = (request: ReturnType<typeof prompt>) =>
      host.localRequest.post("/api/prompt").send(request);
    const stop = () =>
      host.localRequest
        .post("/api/control/abort")
        .send(host.promptDelivery(address));
    const idle = () =>
      vi.waitFor(() =>
        expect(connection.read()).resolves.toMatchObject({ activity: "idle" }),
      );
    expect(
      (await send(prompt("normal attached input")).expect(202)).body.state,
    ).toBe("completed");
    await idle();
    expect(await readFile(sessionFile, "utf8")).toContain(
      "normal attached input",
    );

    const run = pi.request({ type: "prompt", message: "gated run" });
    void run.catch(() => {});
    const releaseRun = await holdNativeInput(root, "gated run");
    try {
      for (const behavior of ["steer", "followUp"] as const) {
        const code = "ATTACH_CONTROL_QUEUE_ACK_UNAVAILABLE";
        expect(
          (await send(prompt(behavior, { behavior })).expect(409)).body,
        ).toMatchObject({ state: "rejected", error: { code } });
      }
      await expect(pi.request({ type: "get_state" })).resolves.toMatchObject({
        pendingMessageCount: 0,
      });
    } finally {
      await releaseRun();
    }
    await run;
    await idle();

    const providerRequests = join(root, "provider-requests");
    const beforeStop = await readFile(providerRequests, "utf8");
    const input = "gated input";
    const sending = send(prompt(input))
      .expect(202)
      .then(({ body }) => body);
    void sending.catch(() => {});
    const releaseInput = await holdNativeInput(root, input);
    try {
      // A lexical match submitted independently to native Pi is no witness for this input.
      await pi.request({ type: "prompt", message: input });
      await vi.waitFor(async () => {
        expect(await readFile(providerRequests, "utf8")).toBe(
          beforeStop + "request\n",
        );
        expect(await connection.read()).toMatchObject({ activity: "idle" });
      });
      expect((await stop().expect(502)).body).toMatchObject({
        state: "unknown",
        error: { code: UNKNOWN_OUTCOME },
      });
    } finally {
      await releaseInput();
    }
    await expect(sending).resolves.toMatchObject({ state: "completed" });
    await idle();
    expect(await readFile(providerRequests, "utf8")).toBe(
      beforeStop + "request\n",
    );
    await stop().expect(200);

    const store = host.attachments;
    const imageUpload = upload("image.gif", "image/gif");
    imageUpload.buffer = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64",
    );
    imageUpload.size = imageUpload.buffer.length;
    const fileUpload = upload("notes.txt", "text/plain");
    const image = await store.add(imageUpload);
    const file = await store.add(fileUpload);
    const attachmentIds = [image.id, file.id];
    const uploadDirectory = await store.uploadDirectory();
    const beforeSend = new Set(await readdir(uploadDirectory));
    const beforeLost = await readFile(sessionFile, "utf8");
    const failures: unknown[] = [];
    const recordFailure = (event: {
      type: string;
      event?: string;
      error?: unknown;
    }) => {
      if (
        event.type === "extension_error" &&
        event.event === "send_user_message"
      )
        failures.push(event.error);
    };
    pi.on("event", recordFailure);
    const operation = prompt("lost auth", { attachmentIds });
    const unknown = send(operation)
      .expect(502)
      .then(({ body }) => body);
    void unknown.catch(() => {});
    const releaseLost = await holdNativeInput(root, "lost auth");
    await releaseLost();
    const receipt = await unknown;
    expect(receipt).toMatchObject({
      state: "unknown",
      error: { code: UNKNOWN_OUTCOME },
    });
    expect((await send(operation).expect(502)).body).toEqual(receipt);
    pi.off("event", recordFailure);
    expect(failures).toEqual([expect.stringContaining("No API key found")]);
    expect(await readFile(sessionFile, "utf8")).toBe(beforeLost);
    expect(host.spawn).not.toHaveBeenCalled();

    const copies = (await readdir(uploadDirectory)).filter(
      (name) => !beforeSend.has(name) && !name.endsWith(".json"),
    );
    expect(copies).toHaveLength(1);
    const imagePath = join(uploadDirectory, copies[0]!);
    const filePath = join(uploadDirectory, `${file.id}-notes.txt`);
    expect((await store.imagePreview(image.id)).bytes).toEqual(
      imageUpload.buffer,
    );
    expect(
      (await send(prompt("", { attachmentIds: [image.id] })).expect(409)).body,
    ).toMatchObject({
      state: "rejected",
      error: { code: "ATTACH_CONTROL_AUTH_UNAVAILABLE" },
    });
    expect((await store.imagePreview(image.id)).bytes).toEqual(
      imageUpload.buffer,
    );
    await store.remove(image.id);
    await store.remove(file.id);
    expect(store.ownsPromptFile(filePath)).toBe(true);
    expect(await readFile(imagePath)).toEqual(imageUpload.buffer);
    expect((await store.collectStaged()).reclaimed).not.toContain(imagePath);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.advanceTimersByTime(6 * 60_000);
      await expect(store.collectStaged()).resolves.toMatchObject({
        reclaimed: [imagePath],
      });
    } finally {
      vi.useRealTimers();
    }
    await expect(readFile(imagePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(filePath)).toEqual(fileUpload.buffer);
  }, 25_000);

  it("acknowledges Steer and Follow up through the native terminal before its current run can finish", async () => {
    const fixture = await attachWorkspace();
    const { id, root, sessionFile, environment, registry, agent, settings } =
      fixture;
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({ ...settings, extensions: [resolve(ATTACH_PROMPT)] }),
    );
    const terminal = pty.spawn(
      process.execPath,
      [
        "--import",
        resolve("node_modules/tsx/dist/loader.mjs"),
        resolve("server/attached-pi-entry.ts"),
        "--session",
        sessionFile,
      ],
      {
        cwd: root,
        name: "xterm-256color",
        env: {
          ...environment,
          INSPIRE_PI_COMMAND: piInstallation.commandPath,
          INSPIRE_ATTACH_TEST_NATIVE: "1",
        },
      },
    );
    let output = "";
    terminal.onData((data) => {
      output = (output + data).slice(-6000);
    });
    const exited = new Promise<void>((resolveExit) =>
      terminal.onExit(() => resolveExit()),
    );
    cleanup.push(async () => {
      terminal.kill();
      await exited;
    });
    const record = await soleReceiver(fixture).catch((error) => {
      throw new Error(output, { cause: error });
    });
    expect(record.mode).toBe("tui");
    await vi.waitFor(async () =>
      expect(
        JSON.parse(await readFile(join(root, "native-commands.json"), "utf8")),
      ).toContain("mcp"),
    );
    terminal.write("gated run\r");
    const releaseRun = await holdNativeInput(root, "gated run");
    try {
      const host = await attachedHost(fixture);
      for (const behavior of ["steer", "followUp"] as const) {
        await expect(
          requestAttachControl(record.endpoint, {
            token: record.token,
            op: "prompt",
            behavior,
            sessionFile,
            message: `test ${behavior}`,
          }),
        ).resolves.toMatchObject({
          ok: true,
          witnessed: true,
          disposition: "queued",
          state: { sessionId: id, activity: "working" },
        });
        const operation = host.promptDelivery({
          sessionId: id,
          behavior,
          message: `from browser ${behavior}`,
        });
        await host.localRequest
          .post("/api/prompt")
          .send(operation)
          .expect(202)
          .expect(({ body }) =>
            expect(body).toMatchObject({
              command: "prompt",
              operationId: operation.operationId,
              executor: { authorityId: operation.authorityId },
              state: "completed",
            }),
          );
      }
      await expect(
        access(join(root, "gated run.release")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(registry.forSession(id, sessionFile)).resolves.toHaveLength(
        1,
      );
    } finally {
      await releaseRun();
    }
  }, 30_000);

  it("rejects unauthenticated prompts and fences an input still in preflight when stopped", async () => {
    const root = await mkdtemp(join(await realpath("/tmp"), "pi-gate-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    vi.stubEnv("HOME", root);
    vi.stubEnv("XDG_RUNTIME_DIR", root);
    vi.stubEnv("PI_ATTACH_CONTROL", undefined);
    vi.stubEnv("PI_ATTACH_CONTROL_RPC_UI", undefined);
    vi.stubEnv("PI_ATTACH_CONTROL_TAG", "inherited-worker");
    vi.stubEnv("PI_ATTACH_CONTROL_TAG_PARENT_PID", "0");
    cleanup.push(async () => vi.unstubAllEnvs());

    let resolveAuth!: (auth: undefined) => void;
    const auth = new Promise<undefined>((resolve) => {
      resolveAuth = resolve;
    });
    const getProviderAuth = vi.fn(() => auth);
    const abort = vi.fn();
    const sendUserMessage = vi.fn();
    const hooks = new Map<
      string,
      (event: unknown, ctx: ExtensionContext) => unknown
    >();
    attachControl({
      on: (
        event: string,
        callback: (event: unknown, ctx: ExtensionContext) => unknown,
      ) => hooks.set(event, callback),
      getThinkingLevel: () => "off",
      sendUserMessage,
    } as unknown as ExtensionAPI);
    const sessionFile = join(root, "session.jsonl");
    const ctx = {
      cwd: root,
      mode: "tui",
      model: { provider: "fixture", id: "offline" },
      modelRegistry: { hasConfiguredAuth: () => false, getProviderAuth },
      isIdle: () => true,
      abort,
      sessionManager: {
        getSessionId: () => "session",
        getSessionFile: () => sessionFile,
        getLeafId: () => null,
        getSessionName: () => "fixture",
      },
    } as unknown as ExtensionContext;
    await hooks.get("session_start")?.({}, ctx);
    cleanup.push(async () => {
      await hooks.get("session_shutdown")?.({}, ctx);
    });

    const registry = new AttachControlRegistry(attachControlDirectory());
    const [record] = await registry.forSession("session", sessionFile);
    expect(record?.endpoint).toBeTruthy();
    expect(record?.tag).toBeUndefined();
    const connection = new AttachControlConnection(registry, record!);
    const stopped = expect(
      connection.prompt("before stop"),
    ).rejects.toMatchObject({
      code: "ATTACH_CONTROL_STOPPED",
    });
    await vi.waitFor(() => expect(getProviderAuth).toHaveBeenCalledOnce());
    await connection.abort();
    resolveAuth(undefined);
    await stopped;
    await expect(connection.prompt("after stop")).rejects.toMatchObject({
      code: "ATTACH_CONTROL_NO_AUTH",
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("reuses an idle native receiver, refuses stale branch controls, and follows Pi across reload", async () => {
    const fixture = await livePi({ PI_ATTACH_CONTROL_TAG: "worker-one" }, [
      NAVIGATE,
      RELOAD,
      "extensions/attach-control.ts",
    ]);
    const { pi, registry, id, sessionFile } = fixture;
    const record = await soleReceiver(fixture);
    expect(record).toMatchObject({ activity: "idle", tag: "worker-one" });
    const startLeaf = record.leafId;
    expect(typeof startLeaf).toBe("string");
    const connection = new AttachControlConnection(registry, record);

    expect(
      await requestAttachControl(record.endpoint, {
        op: "state",
        token: "wrong",
      }),
    ).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(await connection.read()).toMatchObject({
      activity: "idle",
      leafId: startLeaf,
    });

    const before = await readFile(sessionFile, "utf8");

    // Even at the prompt size limit, escaping must preserve input validation.
    for (const message of [
      " /attach-control old-id",
      `!!${"\u0000".repeat(499_998)}`,
    ]) {
      await expect(
        requestAttachControl(record.endpoint, {
          op: "prompt",
          token: record.token,
          sessionFile,
          message,
        }),
      ).resolves.toMatchObject({ ok: false, code: "NATIVE_INPUT_UNSUPPORTED" });
    }

    await expect(pi.request({ type: "get_state" })).resolves.toMatchObject({
      isStreaming: false,
    });
    expect(await readFile(sessionFile, "utf8")).toBe(before);

    const { runtime, spawn } = replacementRuntime(fixture);
    const release = runtime.retainSessionView(id);
    cleanup.push(async () => release());
    await vi.waitFor(
      async () =>
        expect(await runtime.snapshot(id)).toMatchObject({
          sessionStatuses: { [id]: { external: true } },
        }),
      { timeout: 10_000 },
    );
    expect((await runtime.snapshot(id)).active?.readOnlyReason).toBeUndefined();
    expect(runtime.startupSessionHint).toBeNull();
    await runtime.rename(id, "Renamed from Inspire");
    await vi.waitFor(async () =>
      expect(await readFile(sessionFile, "utf8")).toContain(
        "Renamed from Inspire",
      ),
    );
    expect(spawn).not.toHaveBeenCalled();
    expect((await connection.setThinkingLevel("high")).thinkingLevel).toBe(
      "high",
    );
    const refuses = async (leaf: string | null) => {
      const mismatch = { code: "ATTACH_CONTROL_BRANCH_CHANGED" };
      await expect(
        connection.prompt(
          "wrong context",
          undefined,
          undefined,
          undefined,
          leaf,
        ),
      ).rejects.toMatchObject(mismatch);
      await expect(connection.abort(leaf)).rejects.toMatchObject(mismatch);
    };
    await refuses(null);

    // The terminal user moves to another entry. The receiver checks the
    // submitted branch at the actual input/Stop boundary.
    await pi.request({ type: "prompt", message: "/test-navigate u1" });
    await vi.waitFor(
      async () =>
        expect(await connection.read()).toMatchObject({ leafId: null }),
      { timeout: 5_000 },
    );
    await refuses(startLeaf!);

    // Reloading through Pi itself replaces the extension instance, and the
    // attachment follows the same process to the new socket.
    await pi.request({ type: "prompt", message: "/fixture-reload" });
    await vi.waitFor(
      async () => {
        const [next] = await registry.forSession(id, sessionFile);
        expect(next?.pid).toBe(record.pid);
        expect(next?.instanceId).not.toBe(record.instanceId);
      },
      { timeout: 15_000 },
    );
    expect(await connection.read()).toMatchObject({ activity: "idle" });
  }, 60_000);

  it("Clear Hidden ends every branch instance before trashing an unopened session and leaves other sessions running", async () => {
    const first = await livePi({}, ["docs/examples/native-ui.ts"]);
    const environment =
      process.platform === "darwin"
        ? { HOME: first.home }
        : { XDG_RUNTIME_DIR: first.runtimeDir };
    const otherBranch = await livePi(
      { ...environment, PI_ATTACH_CONTROL_TAG: "other-branch" },
      [NAVIGATE],
      first,
    );
    const unrelated = await livePi(environment);
    const records = await vi.waitFor(
      async () => {
        const found = await first.registry.forSession(
          first.id,
          first.sessionFile,
        );
        expect(found).toHaveLength(2);
        return found;
      },
      { timeout: 15_000 },
    );
    const second = new AttachControlConnection(
      first.registry,
      records.find((record) => record.tag === "other-branch")!,
    );
    expect(records[0]?.leafId).not.toBeNull();
    expect(records[0]?.leafId).toBe(records[1]?.leafId);
    expect(() => takeoverCandidate(records, () => "continues")).toThrow(
      /Several Pi processes/,
    );
    await otherBranch.pi.request({
      type: "prompt",
      message: "/test-navigate u1",
    });
    await vi.waitFor(
      async () => expect(await second.read()).toMatchObject({ leafId: null }),
      { timeout: 5_000 },
    );
    // One of the targets is blocked on a real native question.
    const asking = first.pi
      .request({ type: "prompt", message: "/ui-demo" })
      .catch(() => undefined);
    await vi.waitFor(
      async () =>
        expect(
          (await first.registry.forSession(first.id, first.sessionFile)).some(
            (record) => record.activity === "blocked",
          ),
        ).toBe(true),
      { timeout: 10_000 },
    );
    const { attachments, catalog: source } = hostServices(first.home, {
      cwd: first.root,
    });
    const trash = join(first.root, "trashed.jsonl");
    const runtime = new RuntimeController(source, attachments, {
      deleteSessionRecord: (target) =>
        deleteSessionFile(target, async (payload) => {
          expect(
            await first.registry.forSession(first.id, first.sessionFile),
          ).toEqual([]);
          expect(
            await first.registry.forSession(
              unrelated.id,
              unrelated.sessionFile,
            ),
          ).toHaveLength(1);
          await rename(payload, trash);
        }),
    }).setExternalSessionTerminator((id, path) =>
      first.registry.stopSession(id, path),
    );
    cleanup.push(() => attachments.close());
    cleanup.push(() => runtime.close());
    await expect(
      runtime.deleteSessions(
        { scope: "hidden", sessionIds: [first.id] },
        { hiddenSessionIds: [first.id], hiddenProjectCwds: [] },
      ),
    ).resolves.toEqual({
      deleted: [{ sessionId: first.id, disposition: "trashed" }],
    });
    await asking;
    expect(await readFile(trash, "utf8")).toContain(first.id);
    await expect(readFile(first.sessionFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);
});
