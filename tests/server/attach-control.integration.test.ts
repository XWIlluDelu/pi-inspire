import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
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
import { AttachmentStore } from "../../server/attachments.js";
import { piInstallation } from "../../server/pi-installation.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import type { SessionRecord } from "../../server/session-catalog.js";
import { deleteSessionFile } from "../../server/session-delete.js";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";
import { catalog } from "./fixtures/runtime.js";

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
  id,
  sessionFile,
  root,
}: {
  registry: AttachControlRegistry;
  id: string;
  sessionFile: string;
  root: string;
}) {
  const session: SessionRecord = {
    id,
    path: sessionFile,
    cwd: root,
    source: null,
    created: new Date(),
    modified: new Date(),
    messageCount: 2,
    firstMessage: "first",
  };
  const attachments = new AttachmentStore(join(root, "uploads"));
  const spawn = vi.fn(() => {
    throw new Error("An external session must reuse its live Pi");
  });
  const runtime = new RuntimeController(catalog([session]), attachments, {
    createProcess: spawn,
  })
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
  cleanup.push(() => attachments.close());
  cleanup.push(() => runtime.close());
  return { runtime, spawn };
}

/** A real Pi with attach-control loaded, as a user's terminal Pi would be. */
async function livePi(
  env: NodeJS.ProcessEnv = {},
  extensions: string[] = [],
  resume?: { id: string; sessionFile: string },
) {
  const macOS = process.platform === "darwin";
  // macOS uses the fixture's home cache for attach-control sockets. Its
  // default temporary directory is too long for the Unix socket address.
  const root = await mkdtemp(
    macOS
      ? join(await realpath("/tmp"), "pi-ac-")
      : join(tmpdir(), "attach-control-pi-"),
  );
  cleanup.push(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const config = join(root, "config");
  const sessions = join(root, "sessions");
  const runtimeDir = env.XDG_RUNTIME_DIR ?? join(root, "run");
  await Promise.all(
    [config, sessions, runtimeDir].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  await writeFile(join(config, "auth.json"), "{}\n");
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({
      defaultProvider: "fixture",
      defaultModel: "offline",
      defaultThinkingLevel: "off",
      defaultProjectTrust: "never",
      enableInstallTelemetry: false,
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );
  await writeFile(
    join(config, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          apiKey: "$INSPIRE_TEST_ATTACH_API_KEY",
          baseUrl: "http://127.0.0.1:1/v1",
          models: [
            {
              id: "offline",
              reasoning: true,
              contextWindow: 8192,
              maxTokens: 128,
            },
          ],
        },
      },
    }),
  );
  const id = resume?.id ?? randomUUID();
  const sessionFile = resume?.sessionFile ?? join(sessions, `${id}.jsonl`);
  const timestamp = "2026-01-01T00:00:00.000Z";
  const entries = [
    { type: "session", version: 3, id, timestamp, cwd: root },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp,
      message: { role: "user", content: "first", timestamp: 1 },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        api: "openai-completions",
        provider: "fixture",
        model: "offline",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ];
  if (!resume)
    await writeFile(
      sessionFile,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  const environment = isolatedTestEnvironment(root, {
    PI_CODING_AGENT_DIR: config,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    XDG_RUNTIME_DIR: runtimeDir,
    INSPIRE_TEST_ATTACH_API_KEY: "synthetic",
    ...env,
  });
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
  await pi.start();
  cleanup.push(() => pi.stop());
  const registry = new AttachControlRegistry(
    macOS
      ? join(env.HOME ?? root, "Library", "Caches", "pi-attach-control")
      : join(runtimeDir, "pi-attach-control"),
  );
  return { pi, registry, id, sessionFile, root, environment };
}

async function soleReceiver({
  registry,
  id,
  sessionFile,
}: Awaited<ReturnType<typeof livePi>>) {
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

async function promptFixture() {
  const fixture = await livePi({}, [ATTACH_PROMPT]);
  const { registry, root } = fixture;
  const record = await soleReceiver(fixture);
  const enter = async (name: string) => {
    const release = () => writeFile(join(root, `${name}.release`), "");
    cleanup.push(release);
    await vi.waitFor(() => access(join(root, `${name}.entered`)), {
      timeout: 5_000,
    });
    return release;
  };
  return {
    ...fixture,
    enter,
    connection: new AttachControlConnection(registry, record),
  };
}

const UNKNOWN_OUTCOME = {
  code: "ATTACH_CONTROL_OUTCOME_UNKNOWN",
  outcomeUnknown: true,
};

describe.skipIf(process.platform === "win32")("attach-control in Pi", () => {
  it("witnesses ordinary input and reports unknown after Pi rejects a handed-off input", async () => {
    const { pi, connection, enter, sessionFile } = await promptFixture();
    await connection.prompt("normal attached input");
    await vi.waitFor(async () => {
      expect(await connection.read()).toMatchObject({ activity: "idle" });
    });
    const before = await readFile(sessionFile, "utf8");
    expect(before).toContain("normal attached input");

    const failures: unknown[] = [];
    pi.on("event", (event) => {
      if (
        event.type === "extension_error" &&
        event.event === "send_user_message"
      )
        failures.push(event.error);
    });
    const result = expect(connection.prompt("lost auth")).rejects.toMatchObject(
      UNKNOWN_OUTCOME,
    );
    const release = await enter("lost auth");
    await release();
    await result;
    expect(failures).toEqual([expect.stringContaining("No API key found")]);
    expect(await readFile(sessionFile, "utf8")).toBe(before);
  }, 20_000);

  it("reports an uncertain Stop during native preflight and aborts its matching late start", async () => {
    const { pi, connection, enter, root } = await promptFixture();
    const message = "gated input";
    const result = connection.prompt(message);
    void result.catch(() => {});
    const release = await enter(message);

    // An independent native submit with identical text is not the witness.
    await pi.request({ type: "prompt", message });
    const requests = join(root, "provider-requests");
    await vi.waitFor(async () => {
      expect(await readFile(requests, "utf8")).toBe("request\n");
      expect(await connection.read()).toMatchObject({ activity: "idle" });
    });
    await expect(connection.abort()).rejects.toMatchObject(UNKNOWN_OUTCOME);
    await release();
    await result;
    await vi.waitFor(async () => {
      expect(await connection.read()).toMatchObject({ activity: "idle" });
    });
    expect(await readFile(requests, "utf8")).toBe("request\n");
    await connection.abort();
  }, 20_000);

  it("refuses unconfirmable Steer and Follow up before changing Pi's queue", async () => {
    const { pi, connection, enter } = await promptFixture();
    const run = pi.request({ type: "prompt", message: "gated run" });
    void run.catch(() => {});
    const release = await enter("gated run");
    await Promise.all([
      expect(
        connection.prompt("next steering input", "steer"),
      ).rejects.toMatchObject({
        code: "ATTACH_CONTROL_QUEUE_ACK_UNAVAILABLE",
      }),
      expect(
        connection.prompt("later follow up", "followUp"),
      ).rejects.toMatchObject({
        code: "ATTACH_CONTROL_QUEUE_ACK_UNAVAILABLE",
      }),
    ]);
    await expect(pi.request({ type: "get_state" })).resolves.toMatchObject({
      pendingMessageCount: 0,
    });
    await release();
    await run;
  }, 20_000);

  it("acknowledges Steer and Follow up through the native terminal before its current run can finish", async () => {
    const fixture = await livePi();
    const { id, root, sessionFile, environment, registry } = fixture;
    await fixture.pi.stop();
    const config = join(root, "config", "settings.json");
    const settings = JSON.parse(await readFile(config, "utf8"));
    await writeFile(
      config,
      JSON.stringify({ ...settings, extensions: [resolve(ATTACH_PROMPT)] }),
    );
    const terminal = pty.spawn(
      process.execPath,
      [resolve("inspire.mjs"), "pi", "--session", sessionFile],
      {
        cwd: root,
        name: "xterm-256color",
        env: {
          ...environment,
          INSPIRE_PI_COMMAND: piInstallation.commandPath,
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
    terminal.write("gated run\r");
    await vi.waitFor(() => access(join(root, "gated run.entered")), {
      timeout: 5_000,
    });
    try {
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
      await writeFile(join(root, "gated run.release"), "");
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

  it("controls one native receiver, refuses remote commands, and follows it across reload", async () => {
    const fixture = await livePi({}, [
      NAVIGATE,
      RELOAD,
      "extensions/attach-control.ts",
    ]);
    const { pi, registry, id, sessionFile } = fixture;
    const record = await soleReceiver(fixture);
    // Pi records its startup model selection after the saved entries.
    expect(record).toMatchObject({ activity: "idle" });
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

    await connection.rename("Attached name");
    await vi.waitFor(
      async () =>
        expect(await readFile(sessionFile, "utf8")).toContain("Attached name"),
      { timeout: 5_000 },
    );

    expect((await connection.setThinkingLevel("high")).thinkingLevel).toBe(
      "high",
    );
    await expect(
      connection.prompt(
        "empty branch already advanced",
        undefined,
        undefined,
        undefined,
        null,
      ),
    ).rejects.toMatchObject({ code: "ATTACH_CONTROL_BRANCH_CHANGED" });
    await expect(connection.abort(null)).rejects.toMatchObject({
      code: "ATTACH_CONTROL_BRANCH_CHANGED",
    });

    // The terminal user moves to another entry. The receiver checks the
    // submitted branch at the actual input/Stop boundary.
    await pi.request({ type: "prompt", message: "/test-navigate u1" });
    await vi.waitFor(
      async () =>
        expect(await connection.read()).toMatchObject({ leafId: null }),
      { timeout: 5_000 },
    );
    await expect(
      connection.prompt(
        "wrong context",
        undefined,
        undefined,
        undefined,
        startLeaf,
      ),
    ).rejects.toMatchObject({ code: "ATTACH_CONTROL_BRANCH_CHANGED" });
    await expect(connection.abort(startLeaf)).rejects.toMatchObject({
      code: "ATTACH_CONTROL_BRANCH_CHANGED",
    });

    // Reloading through Pi itself replaces the extension instance, and the
    // attachment follows the same process to the new socket.
    await pi.request({ type: "prompt", message: "/fixture-reload" });
    await vi.waitFor(
      async () => {
        const [next] = await registry.forSession(id, sessionFile);
        expect(next?.instanceId).toBeDefined();
        expect(next?.instanceId).not.toBe(record.instanceId);
      },
      { timeout: 15_000 },
    );
    expect(await connection.read()).toMatchObject({ activity: "idle" });
  }, 60_000);

  it("automatically attaches to an idle external Pi when observing its session", async () => {
    const fixture = await livePi({
      PI_ATTACH_CONTROL_TAG: "worker-one",
    });
    const { registry, id, sessionFile } = fixture;
    const record = await soleReceiver(fixture);
    expect(record.tag).toBe("worker-one");
    const { runtime, spawn } = replacementRuntime(fixture);
    const release = runtime.retainSessionView(id);
    cleanup.push(async () => release());
    await vi.waitFor(
      async () => {
        const snapshot = await runtime.snapshot(id);
        expect(snapshot.sessionStatuses[id]?.external).toBe(true);
        expect(snapshot.active?.readOnlyReason).toBeUndefined();
      },
      { timeout: 10_000 },
    );
    expect(runtime.startupSessionHint).toBeNull();
    await runtime.rename(id, "Renamed from Inspire");
    await vi.waitFor(
      async () =>
        expect(await readFile(sessionFile, "utf8")).toContain(
          "Renamed from Inspire",
        ),
      { timeout: 5_000 },
    );
    expect(spawn).not.toHaveBeenCalled();
    expect((await registry.forSession(id, sessionFile))[0]?.pid).toBe(
      record.pid,
    );
  }, 60_000);

  it("Clear Hidden ends every branch instance before trashing an unopened session and leaves other sessions running", async () => {
    const first = await livePi({}, ["docs/examples/native-ui.ts"]);
    const environment =
      process.platform === "darwin"
        ? { HOME: first.root }
        : { XDG_RUNTIME_DIR: join(first.root, "run") };
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
    const { dev, ino, size, mtimeNs, ctimeNs } = await lstat(
      first.sessionFile,
      { bigint: true },
    );
    const session: SessionRecord = {
      id: first.id,
      path: first.sessionFile,
      cwd: first.root,
      source: { dev, ino, size, mtimeNs, ctimeNs },
      created: new Date(),
      modified: new Date(),
      messageCount: 2,
      firstMessage: "first",
    };
    const attachments = new AttachmentStore(join(first.root, "uploads"));
    const trash = join(first.root, "trashed.jsonl");
    const runtime = new RuntimeController(catalog([session]), attachments, {
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
      runtime.clearHiddenSessions([first.id], [first.id], []),
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
