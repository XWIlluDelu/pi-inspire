import { spawn } from "node:child_process";
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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import attachControl, {
  type AttachControlRequest,
  attachControlDirectory,
  requestAttachControl,
} from "../../extensions/attach-control.js";
import {
  AttachControlConnection,
  AttachControlRegistry,
} from "../../server/attach-control.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { HerdrRpcTransport } from "../../server/herdr-rpc-transport.js";
import { HerdrWorkerRegistry } from "../../server/herdr-worker-registry.js";
import { assertHerdrWorkerScopesAvailable } from "../../server/herdr-process-group.js";
import { RuntimeController } from "../../server/runtime.js";
import { AttachmentStore } from "../../server/attachments.js";
import type { SessionRecord } from "../../server/session-catalog.js";
import { deleteSessionFile } from "../../server/session-delete.js";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";

const herdrAvailable =
  process.platform === "linux" &&
  (await assertHerdrWorkerScopesAvailable(process.env).then(
    () => true,
    () => false,
  ));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const NAVIGATE = "tests/fixtures/pi-navigate-extension.ts";
const RELOAD = "tests/fixtures/pi-resource-reload-extension.ts";
const ATTACH_PROMPT = "tests/fixtures/pi-attach-prompt-extension.ts";

/** A real Pi with attach-control loaded, as a user's terminal Pi would be. */
async function livePi(
  env: NodeJS.ProcessEnv = {},
  extensions: string[] = [],
  resume?: { id: string; sessionFile: string },
  backend: "direct" | "herdr" = "direct",
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
  const leases = new HerdrWorkerRegistry(join(root, "leases"));
  const pi = new PiRpcProcess({
    cwd: root,
    createTransport:
      backend === "herdr"
        ? (launch) =>
            new HerdrRpcTransport(launch, {
              registry: leases,
              // The fixture pane uses the test runner environment, not Pi's isolated home.
              assertScopesAvailable: () =>
                assertHerdrWorkerScopesAvailable(process.env),
              label: "dialog recovery",
              client: {
                async createWorkerPane(cwd, _label, argv) {
                  const bridge = spawn(argv[0]!, argv.slice(1), {
                    cwd,
                    env: process.env,
                    detached: true,
                    stdio: "ignore",
                  });
                  cleanup.push(async () => {
                    if (
                      bridge.pid &&
                      bridge.exitCode === null &&
                      bridge.signalCode === null
                    ) {
                      try {
                        process.kill(-bridge.pid, "SIGKILL");
                      } catch {}
                    }
                  });
                  await new Promise<void>((resolve, reject) => {
                    bridge.once("spawn", resolve);
                    bridge.once("error", reject);
                  });
                  return {
                    serverId: "dialog-test",
                    workspaceId: "w1",
                    tabId: "t1",
                    paneId: "p1",
                  };
                },
                async closePane() {},
              },
            })
        : undefined,
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
    env: isolatedTestEnvironment(root, {
      PI_CODING_AGENT_DIR: config,
      PI_CODING_AGENT_SESSION_DIR: sessions,
      XDG_RUNTIME_DIR: runtimeDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      INSPIRE_TEST_ATTACH_API_KEY: "synthetic",
      ...env,
    }),
  });
  await pi.start();
  cleanup.push(() => pi.stop());
  const registry = new AttachControlRegistry(
    macOS
      ? join(env.HOME ?? root, "Library", "Caches", "pi-attach-control")
      : join(runtimeDir, "pi-attach-control"),
  );
  return { pi, registry, id, sessionFile, root };
}

async function promptFixture() {
  const fixture = await livePi({}, [ATTACH_PROMPT]);
  const { registry, id, sessionFile, root } = fixture;
  const record = await vi.waitFor(
    async () => {
      const [found] = await registry.forSession(id, sessionFile);
      expect(found?.endpoint).toBeTruthy();
      return found!;
    },
    { timeout: 5_000 },
  );
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
      expect(await connection.read()).toMatchObject({ status: "idle" });
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
      expect(await connection.read()).toMatchObject({ status: "idle" });
    });
    await expect(connection.abort()).rejects.toMatchObject(UNKNOWN_OUTCOME);
    await release();
    await result;
    await vi.waitFor(async () => {
      expect(await connection.read()).toMatchObject({ status: "idle" });
    });
    expect(await readFile(requests, "utf8")).toBe("request\n");
    await connection.abort();
  }, 20_000);

  it("reports unknown for Steer and Follow up queued by native Pi", async () => {
    const { pi, connection, enter } = await promptFixture();
    const run = pi.request({ type: "prompt", message: "gated run" });
    void run.catch(() => {});
    const release = await enter("gated run");
    await Promise.all([
      expect(
        connection.prompt("next steering input", "steer"),
      ).rejects.toMatchObject(UNKNOWN_OUTCOME),
      expect(
        connection.prompt("later follow up", "followUp"),
      ).rejects.toMatchObject(UNKNOWN_OUTCOME),
    ]);
    await expect(pi.request({ type: "get_state" })).resolves.toMatchObject({
      pendingMessageCount: 2,
    });
    await release();
    await run;
  }, 20_000);

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

  it("publishes presence and controls the live Pi through its socket", async () => {
    const { pi, registry, id, sessionFile } = await livePi({}, [
      NAVIGATE,
      RELOAD,
    ]);
    const [record] = await vi.waitFor(
      async () => {
        const found = await registry.forSession(id, sessionFile);
        expect(found).toHaveLength(1);
        return found;
      },
      { timeout: 15_000 },
    );
    // Pi records its startup model selection after the saved entries.
    expect(record).toMatchObject({ activity: "idle" });
    const startLeaf = record!.leafId;
    expect(typeof startLeaf).toBe("string");
    const connection = new AttachControlConnection(registry, record!);

    expect(await connection.read()).toMatchObject({
      status: "idle",
      leafId: startLeaf,
    });

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
        expect(next?.instanceId).not.toBe(record!.instanceId);
      },
      { timeout: 15_000 },
    );
    expect(await connection.read()).toMatchObject({ status: "idle" });
  }, 60_000);

  it("rejects legacy remote reload without sending a prompt when two copies are loaded", async () => {
    const { pi, registry, id, sessionFile } = await livePi({}, [
      "docs/examples/session-activity.ts",
    ]);
    const [record] = await vi.waitFor(
      async () => {
        const found = await registry.forSession(id, sessionFile);
        expect(found).toHaveLength(1);
        return found;
      },
      { timeout: 15_000 },
    );
    const before = await readFile(sessionFile, "utf8");

    // An old Host sends an operation outside today's typed protocol.
    await expect(
      requestAttachControl(record!.endpoint, {
        op: "reload",
        token: record!.token,
        sessionFile,
      } as unknown as AttachControlRequest),
    ).resolves.toMatchObject({ ok: false, code: "UNSUPPORTED" });

    // Escaping can grow a prompt far past the old 64 KiB wire limit. The
    // complete request reaches validation without executing the command.
    for (const message of [
      " /attach-control old-id",
      `!!${"\u0000".repeat(499_998)}`,
    ]) {
      await expect(
        requestAttachControl(record!.endpoint, {
          op: "prompt",
          token: record!.token,
          sessionFile,
          message,
        }),
      ).resolves.toMatchObject({ ok: false, code: "NATIVE_INPUT_UNSUPPORTED" });
    }

    await expect(pi.request({ type: "get_state" })).resolves.toMatchObject({
      isStreaming: false,
    });
    expect(await readFile(sessionFile, "utf8")).toBe(before);
  }, 60_000);

  it("keeps a detached worker running and controllable after its Host lets go", async () => {
    const { pi, registry, id, sessionFile } = await livePi({
      PI_ATTACH_CONTROL_TAG: "worker-one",
    });
    const [record] = await vi.waitFor(
      async () => {
        const found = await registry.forSession(id, sessionFile);
        expect(found).toHaveLength(1);
        return found;
      },
      { timeout: 15_000 },
    );
    expect(record!.tag).toBe("worker-one");
    cleanup.push(async () => {
      // A detached Pi is no longer the test's child: wait for it to exit
      // before its temporary folder is removed.
      const alive = () => {
        try {
          process.kill(record!.pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      if (alive()) process.kill(record!.pid, "SIGTERM");
      for (let tries = 0; alive() && tries < 50; tries += 1)
        await new Promise((resolve) => setTimeout(resolve, 100));
    });
    // A Host-only restart detaches instead of stopping: Pi's input stays open.
    await pi.detach();
    const connection = new AttachControlConnection(registry, record!);
    await vi.waitFor(
      async () =>
        expect(await connection.read()).toMatchObject({ status: "idle" }),
      { timeout: 10_000 },
    );
    await connection.rename("Survived the Host");
    await vi.waitFor(
      async () =>
        expect(await readFile(sessionFile, "utf8")).toContain(
          "Survived the Host",
        ),
      { timeout: 5_000 },
    );
  }, 60_000);

  for (const backend of ["direct", "herdr"] as const) {
    it.skipIf(backend === "herdr" && !herdrAvailable)(
      `${backend}: restores a pending RPC dialog and subsequent answers in a replacement Host`,
      async () => {
        const { pi, registry, id, sessionFile, root } = await livePi(
          {},
          ["docs/examples/native-ui.ts"],
          undefined,
          backend,
        );
        const record = await vi.waitFor(
          async () => {
            const [found] = await registry.forSession(id, sessionFile);
            expect(found).toBeDefined();
            return found!;
          },
          { timeout: 15_000 },
        );
        cleanup.push(async () => {
          try {
            process.kill(record.pid, "SIGTERM");
          } catch {
            return;
          }
          await vi.waitFor(
            async () =>
              expect(await registry.forSession(id, sessionFile)).toHaveLength(
                0,
              ),
            { timeout: 10_000 },
          );
        });
        const native = new AttachControlConnection(registry, record);
        const pending = pi
          .request({ type: "prompt", message: "/ui-demo" })
          .catch(() => undefined);
        const first = await vi.waitFor(
          async () => {
            const state = await native.read();
            const request =
              "ended" in state ? undefined : state.uiRequests?.[0];
            expect(request?.method).toBe("select");
            return request!;
          },
          { timeout: 10_000 },
        );
        await pi.detach();
        await pending;
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
          throw new Error("A restart must reuse the surviving Pi");
        });
        const runtime = new RuntimeController(
          {
            get: async (sessionId) => (sessionId === id ? session : undefined),
            refresh: async () => [session],
            list: async () => ({
              sessions: [],
              total: 0,
              offset: 0,
              limit: 40,
            }),
            listByIds: async () => [],
            listByCwds: async () => [],
            invalidate() {},
          },
          attachments,
          { createProcess: spawn },
        )
          .setExternalSessionPresence(async () =>
            (await registry.forSession(id, sessionFile)).map(
              (item) => item.leafId,
            ),
          )
          .setExternalSessionConnector(async () => native);
        cleanup.push(() => attachments.close());
        cleanup.push(() => runtime.close());
        await runtime.openSession(id);
        await runtime.takeOverSession(id);
        expect(
          (await runtime.snapshot(id)).pendingExtensionUiRequests?.[0]?.id,
        ).toBe(first.id);
        for (const [method, answer] of [
          ["select", { value: "Code" }],
          ["confirm", { confirmed: true }],
          ["input", { value: "After restart" }],
          ["editor", { value: "The original Pi continued." }],
        ] as const) {
          const question = await vi.waitFor(
            async () => {
              const value = (await runtime.snapshot(id))
                .pendingExtensionUiRequests?.[0];
              expect(value?.method).toBe(method);
              return value!;
            },
            { timeout: 10_000 },
          );
          await runtime.extensionUiResponse({
            sessionId: id,
            id: question.id,
            ...answer,
          });
        }
        await vi.waitFor(
          async () => {
            expect(await readFile(sessionFile, "utf8")).toContain(
              "The original Pi continued.",
            );
            expect(
              (await runtime.snapshot(id)).pendingExtensionUiRequests,
            ).toEqual([]);
            expect(
              (await runtime.snapshot(id)).active?.readOnlyReason,
            ).toBeUndefined();
          },
          { timeout: 10_000 },
        );
        expect((await registry.forSession(id, sessionFile))[0]?.pid).toBe(
          record.pid,
        );
        expect(spawn).not.toHaveBeenCalled();
        if (backend === "herdr")
          expect(
            await new HerdrWorkerRegistry(join(root, "leases")).list(),
          ).toEqual([]);
      },
      60_000,
    );
  }

  it("ends every branch instance before trashing an unopened session, leaving other sessions running", async () => {
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
    const runtime = new RuntimeController(
      {
        get: async (id) => (id === first.id ? session : undefined),
        refresh: async () => [session],
        list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
        listByIds: async () => [],
        listByCwds: async () => [],
        invalidate() {},
      },
      attachments,
      {
        deleteSessionRecord: (target, version) =>
          deleteSessionFile(
            target,
            async (payload) => {
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
            },
            undefined,
            version,
          ),
      },
    ).setExternalSessionTerminator((id, path) =>
      first.registry.stopSession(id, path),
    );
    cleanup.push(() => attachments.close());
    cleanup.push(() => runtime.close());
    await expect(runtime.deleteSession(first.id)).resolves.toMatchObject({
      disposition: "trashed",
    });
    await asking;
    expect(await readFile(trash, "utf8")).toContain(first.id);
    await expect(readFile(first.sessionFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("rejects requests without the record's token", async () => {
    const { registry, id, sessionFile } = await livePi();
    const [record] = await vi.waitFor(
      async () => {
        const found = await registry.forSession(id, sessionFile);
        expect(found).toHaveLength(1);
        return found;
      },
      { timeout: 15_000 },
    );
    expect(
      await requestAttachControl(record!.endpoint, {
        op: "state",
        token: "wrong",
      }),
    ).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
  }, 60_000);
});
