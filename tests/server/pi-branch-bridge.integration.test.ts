import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../server/session-catalog.js";

const directories: string[] = [];
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function message(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
  timestamp: number,
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message:
      role === "user"
        ? { role, content: text, timestamp }
        : {
            role,
            content: [{ type: "text", text }],
            provider: "test",
            model: "test",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp,
          },
  };
}

function textOf(entry: Record<string, unknown>): string {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((item) =>
        item && typeof item === "object"
          ? String((item as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  return "";
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("installed Pi branch extension bridge", () => {
  it("fails a response-bearing session_start UI request before Pi RPC is ready", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-real-startup-ui-"));
    directories.push(directory);
    const sessionDir = join(directory, "sessions");
    const configDir = join(directory, "config");
    const startupExtension = join(directory, "startup-dialog.ts");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      startupExtension,
      `
export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    await ctx.ui.confirm("Startup dialog", "This cannot be answered before RPC startup");
  });
}
`,
    );
    const catalog: SessionCatalogLike = {
      refresh: async () => [],
      get: async () => undefined,
      list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
      listByIds: async () => [],
      listByCwds: async () => [],
      invalidate() {},
    };
    const attachments = new AttachmentStore(join(directory, "uploads"));
    const workers: PiRpcProcess[] = [];
    const runtime = new RuntimeController(catalog, attachments, (options) => {
      const worker = new PiRpcProcess({
        ...options,
        args: [
          "--no-extensions",
          "--session-dir",
          sessionDir,
          "--extension",
          startupExtension,
          ...(options.args ?? []),
        ],
        env: {
          ...options.env,
          PI_CODING_AGENT_DIR: configDir,
          PI_CODING_AGENT_SESSION_DIR: sessionDir,
          PI_OFFLINE: "1",
        },
      });
      workers.push(worker);
      return worker;
    });
    try {
      const started = Date.now();
      await expect(runtime.newSession(directory)).rejects.toMatchObject({
        code: "PI_STARTUP_RESPONSE_UI_UNSUPPORTED",
        status: 503,
        message: expect.stringContaining(
          "response-bearing extension UI request",
        ),
      });
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(workers).toHaveLength(1);
      expect(runtime.activeSessionId).toBeNull();
    } finally {
      await runtime.close();
      await attachments.close();
    }
  }, 15_000);

  it("keeps the source worker and its dialogs independent from a fork destination", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "inspire-real-runtime-branch-"),
    );
    directories.push(directory);
    const sessionFile = join(directory, "source.jsonl");
    const sessionDir = join(directory, "sessions");
    const hookExtension = join(directory, "dialog-hooks.ts");
    await writeFile(
      hookExtension,
      `
export default function (pi) {
  pi.on("session_before_tree", async (_event, ctx) => {
    if (!await ctx.ui.confirm("Navigate branch?", "Confirm tree navigation")) return { cancel: true };
  });
  pi.on("session_before_fork", async (_event, ctx) => {
    if (await ctx.ui.input("Fork branch?", "Type continue") !== "continue") return { cancel: true };
  });
}
`,
    );
    const entries = [
      message("u1", null, "user", "question one", 1),
      message("a1", "u1", "assistant", "answer one", 2),
      {
        type: "session_info",
        id: "name-1",
        parentId: "a1",
        timestamp: "2026-08-01T00:00:02.500Z",
        name: "Named source",
      },
      message("u2", "name-1", "user", "question two", 3),
      message("a2", "u2", "assistant", "answer two", 4),
    ];
    await writeFile(
      sessionFile,
      `${[
        {
          type: "session",
          version: 3,
          id: SESSION_ID,
          timestamp: "2026-08-01T00:00:00.000Z",
          cwd: directory,
        },
        ...entries,
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    const record: SessionRecord = {
      id: SESSION_ID,
      cwd: directory,
      path: sessionFile,
      source: null,
      created: new Date(),
      modified: new Date(),
      messageCount: entries.length,
      firstMessage: "question one",
      searchText: "question one",
    };
    const catalog: SessionCatalogLike = {
      refresh: async () => [record],
      get: async (id) => (id === SESSION_ID ? record : undefined),
      list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
      listByIds: async () => [],
      listByCwds: async () => [],
      invalidate() {},
    };
    const attachments = new AttachmentStore(join(directory, "uploads"));
    const workers: PiRpcProcess[] = [];
    const runtime = new RuntimeController(catalog, attachments, (options) => {
      const worker = new PiRpcProcess({
        ...options,
        args: [
          "--no-extensions",
          "--session-dir",
          sessionDir,
          ...(options.args ?? []),
          "--extension",
          hookExtension,
        ],
        env: {
          ...options.env,
          PI_CODING_AGENT_DIR: join(directory, "config"),
          PI_CODING_AGENT_SESSION_DIR: sessionDir,
          PI_OFFLINE: "1",
        },
      });
      workers.push(worker);
      return worker;
    });
    const dialogs: Array<Record<string, unknown>> = [];
    const responses: Promise<void>[] = [];
    runtime.on("event", (event) => {
      const record = event as Record<string, unknown>;
      if (
        record.type !== "extension_ui_request" ||
        (record.method !== "confirm" && record.method !== "input")
      )
        return;
      dialogs.push(record);
      responses.push(
        runtime.extensionUiResponse({
          sessionId: record.sessionId,
          id: record.id,
          ...(record.method === "confirm"
            ? { confirmed: true }
            : { value: "continue" }),
        }),
      );
    });
    try {
      await runtime.openSession(SESSION_ID);
      await vi.waitFor(
        async () =>
          expect((await runtime.snapshot()).active?.commands).toBeDefined(),
        { timeout: 10_000 },
      );
      let tree = await runtime.branchTree(SESSION_ID);
      await runtime.navigateBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "a1",
        mode: "switch",
      });
      tree = await runtime.branchTree(SESSION_ID);
      await runtime.navigateBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "a2",
        mode: "switch",
      });
      tree = await runtime.branchTree(SESSION_ID);
      const sourcePid = workers[0]?.pid;
      const forked = await runtime.forkBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "u2",
      });
      expect(forked.snapshot.active?.sessionName).toBe("Named source");
      const destinationTree = await runtime.branchTree(forked.sessionId);
      await runtime.navigateBranch({
        sessionId: forked.sessionId,
        revision: destinationTree.revision,
        targetId: "a1",
        mode: "switch",
      });
      await Promise.all(responses);
      expect(runtime.activeSessionId).toBe(forked.sessionId);
      expect(workers).toHaveLength(2);
      expect(sourcePid).not.toBeNull();
      expect(workers[0]?.pid).toBe(sourcePid);
      expect(workers[1]?.pid).not.toBe(sourcePid);
      expect(await runtime.branchTree(SESSION_ID)).toMatchObject({
        sessionId: SESSION_ID,
      });
      expect(
        dialogs.filter((event) => event.method === "confirm"),
      ).toHaveLength(3);
      expect(dialogs.filter((event) => event.method === "input")).toHaveLength(
        0,
      );
    } finally {
      await runtime.close();
      await attachments.close();
    }
  }, 30_000);

  it("opens and writes a first-turn fork after materializing its header-only Session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-real-root-fork-"));
    directories.push(directory);
    const sessionFile = join(directory, "source.jsonl");
    const sessionDir = join(directory, "sessions");
    const configDir = join(directory, "config");
    await mkdir(configDir, { recursive: true });
    const entries = [
      message("u1", null, "user", "question one", 1),
      message("a1", "u1", "assistant", "answer one", 2),
    ];
    await writeFile(
      sessionFile,
      `${[
        {
          type: "session",
          version: 3,
          id: SESSION_ID,
          timestamp: "2026-08-01T00:00:00.000Z",
          cwd: directory,
        },
        ...entries,
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    const record: SessionRecord = {
      id: SESSION_ID,
      cwd: directory,
      path: sessionFile,
      source: null,
      created: new Date(),
      modified: new Date(),
      messageCount: entries.length,
      firstMessage: "question one",
      searchText: "question one",
    };
    const catalog: SessionCatalogLike = {
      refresh: async () => [record],
      get: async (id) => (id === SESSION_ID ? record : undefined),
      list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
      listByIds: async () => [],
      listByCwds: async () => [],
      invalidate() {},
    };
    const attachments = new AttachmentStore(join(directory, "uploads"));
    const runtime = new RuntimeController(
      catalog,
      attachments,
      (options) =>
        new PiRpcProcess({
          ...options,
          args: [
            "--no-extensions",
            "--session-dir",
            sessionDir,
            ...(options.args ?? []),
          ],
          env: {
            ...options.env,
            PI_CODING_AGENT_DIR: configDir,
            PI_CODING_AGENT_SESSION_DIR: sessionDir,
            PI_OFFLINE: "1",
          },
        }),
    );
    try {
      await runtime.openSession(SESSION_ID);
      await vi.waitFor(
        async () =>
          expect((await runtime.snapshot()).active?.commands).toBeDefined(),
        { timeout: 10_000 },
      );
      const tree = await runtime.branchTree(SESSION_ID);
      const forked = await runtime.forkBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: "u1",
      });
      expect(forked.editorText).toBe("question one");
      expect(forked.snapshot.active?.transcriptPage.messages).toEqual([]);

      await runtime.rename(forked.sessionId, "Writable root fork");
      const destinationText = await readFile(
        forked.snapshot.active!.sessionFile!,
        "utf8",
      );
      expect(destinationText).toContain('"name":"Writable root fork"');
      expect(destinationText).not.toContain("question one");
    } finally {
      await runtime.close();
      await attachments.close();
    }
  }, 30_000);

  it("forks an active stock Pi run without interrupting its later completion", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "inspire-real-active-fork-"),
    );
    directories.push(directory);
    const sessionFile = join(directory, "source.jsonl");
    const sessionDir = join(directory, "sessions");
    const configDir = join(directory, "config");
    await mkdir(configDir, { recursive: true });

    let markModelStarted!: () => void;
    let finishModel!: () => void;
    const modelStarted = new Promise<void>((resolveStarted) => {
      markModelStarted = resolveStarted;
    });
    const modelServer = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Consume the request before beginning the intentionally unfinished
        // streaming response.
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
        "cache-control": "no-cache",
      });
      const chunk = (
        delta: Record<string, string>,
        finishReason: "stop" | null = null,
      ) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-active-fork",
          object: "chat.completion.chunk",
          created: 1,
          model: "offline-model",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      response.write(chunk({ role: "assistant" }));
      response.write(chunk({ content: "partial active answer" }));
      finishModel = () => {
        response.write(chunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      };
      markModelStarted();
    });
    await new Promise<void>((resolveListen, reject) => {
      modelServer.once("error", reject);
      modelServer.listen(0, "127.0.0.1", () => {
        modelServer.off("error", reject);
        resolveListen();
      });
    });
    const modelAddress = modelServer.address() as AddressInfo;
    await writeFile(
      join(configDir, "models.json"),
      JSON.stringify({
        providers: {
          "offline-active": {
            baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
            api: "openai-completions",
            apiKey: "non-secret-test-placeholder",
            models: [
              {
                id: "offline-model",
                name: "Offline active-fork model",
                reasoning: false,
                input: ["text"],
                contextWindow: 32_768,
                maxTokens: 1_024,
              },
            ],
          },
        },
      }),
    );

    const entries = [
      message("u1", null, "user", "question one", 1),
      message("a1", "u1", "assistant", "answer one", 2),
      message("u2", "a1", "user", "question two", 3),
      message("a2", "u2", "assistant", "answer two", 4),
    ];
    await writeFile(
      sessionFile,
      `${[
        {
          type: "session",
          version: 3,
          id: SESSION_ID,
          timestamp: "2026-08-01T00:00:00.000Z",
          cwd: directory,
        },
        ...entries,
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    const catalogRecord: SessionRecord = {
      id: SESSION_ID,
      cwd: directory,
      path: sessionFile,
      source: null,
      created: new Date(),
      modified: new Date(),
      messageCount: entries.length,
      firstMessage: "question one",
      searchText: "question one",
    };
    const catalog: SessionCatalogLike = {
      refresh: async () => [catalogRecord],
      get: async (id) => (id === SESSION_ID ? catalogRecord : undefined),
      list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
      listByIds: async () => [],
      listByCwds: async () => [],
      invalidate() {},
    };
    const attachments = new AttachmentStore(join(directory, "uploads"));
    const workers: PiRpcProcess[] = [];
    const runtime = new RuntimeController(catalog, attachments, (options) => {
      const worker = new PiRpcProcess({
        ...options,
        args: [
          "--no-extensions",
          "--session-dir",
          sessionDir,
          ...(options.args ?? []),
          "--model",
          "offline-active/offline-model",
        ],
        env: {
          ...options.env,
          PI_CODING_AGENT_DIR: configDir,
          PI_CODING_AGENT_SESSION_DIR: sessionDir,
        },
      });
      workers.push(worker);
      return worker;
    });
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) =>
      events.push(event as Record<string, unknown>),
    );
    try {
      await runtime.openSession(SESSION_ID);
      await vi.waitFor(
        async () =>
          expect((await runtime.snapshot()).active?.commands).toBeDefined(),
        { timeout: 10_000 },
      );
      await runtime.prompt({
        sessionId: SESSION_ID,
        message: "active question",
      });
      const sourcePid = workers[0]?.pid;
      await modelStarted;
      await vi.waitFor(async () =>
        expect((await runtime.snapshot()).runState).toBe("running"),
      );
      const tree = await runtime.branchTree(SESSION_ID);
      const activePrompt = tree.nodes.find(
        (node) =>
          node.role === "user" && node.snippet.includes("active question"),
      );
      expect(activePrompt).toMatchObject({ active: true, canFork: true });
      const forked = await runtime.forkBranch({
        sessionId: SESSION_ID,
        revision: tree.revision,
        targetId: activePrompt!.id,
      });
      expect(forked.editorText).toBe("active question");
      const destinationText = await readFile(
        forked.snapshot.active!.sessionFile!,
        "utf8",
      );

      expect(forked.snapshot.runState).toBe("idle");
      expect(forked.snapshot.sessionStatuses[SESSION_ID]?.runState).toBe(
        "running",
      );
      expect(forked.snapshot.pendingQueues).toEqual({
        steering: [],
        followUp: [],
        totalCount: 0,
        revision: 0,
      });
      await vi.waitFor(() => expect(workers).toHaveLength(2));
      expect(sourcePid).not.toBeNull();
      expect(workers[0]?.pid).toBe(sourcePid);
      expect(workers[1]?.pid).not.toBe(sourcePid);
      expect(destinationText).not.toContain("active question");
      expect(destinationText).not.toContain("partial active answer");
      expect(
        events.some(
          (event) =>
            event.type === "message_end" &&
            (event.message as { stopReason?: unknown } | undefined)
              ?.stopReason === "aborted",
        ),
      ).toBe(false);

      finishModel();
      await vi.waitFor(
        async () =>
          expect(
            (await runtime.snapshot()).sessionStatuses[SESSION_ID]?.runState,
          ).toBe("idle"),
        { timeout: 10_000 },
      );
      const sourceText = await readFile(sessionFile, "utf8");
      expect(sourceText).toContain("active question");
      expect(sourceText).toContain("partial active answer");
      expect(
        events.find(
          (event) =>
            event.sessionId === SESSION_ID &&
            event.type === "message_end" &&
            (event.message as { stopReason?: unknown } | undefined)
              ?.stopReason === "stop",
        ),
      ).toBeDefined();
    } finally {
      await runtime.close();
      await attachments.close();
      modelServer.closeAllConnections();
      await new Promise<void>((resolveClose, reject) =>
        modelServer.close((error) => (error ? reject(error) : resolveClose())),
      );
    }
  }, 30_000);

  it("answers no-model tree/fork hook dialogs, survives stock fork rebind, and navigates again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-real-branch-"));
    directories.push(directory);
    const sessionFile = join(directory, "source.jsonl");
    const sessionDir = join(directory, "sessions");
    const hookExtension = join(directory, "dialog-hooks.ts");
    await writeFile(
      hookExtension,
      `
export default function (pi) {
  pi.on("session_before_tree", async (_event, ctx) => {
    const accepted = await ctx.ui.confirm("Navigate branch?", "Confirm tree navigation");
    if (!accepted) return { cancel: true };
  });
  pi.on("session_before_fork", async (_event, ctx) => {
    const answer = await ctx.ui.input("Fork branch?", "Type continue");
    if (answer !== "continue") return { cancel: true };
  });
}
`,
    );
    const entries = [
      message("u1", null, "user", "question one", 1),
      message("a1", "u1", "assistant", "answer one", 2),
      message("u2", "a1", "user", "question two", 3),
      message("a2", "u2", "assistant", "answer two", 4),
      message("u3", "a2", "user", "question three", 5),
      message("a3", "u3", "assistant", "answer three", 6),
    ];
    await writeFile(
      sessionFile,
      `${[
        {
          type: "session",
          version: 3,
          id: SESSION_ID,
          timestamp: "2026-08-01T00:00:00.000Z",
          cwd: directory,
        },
        ...entries,
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );

    const command = "inspire_branch_abcdefghijklmnopqrstuvwxyz123456";
    const statusKey = "inspire_status_abcdefghijklmnopqrstuvwxyz123456";
    const workerId = "worker_abcdefghijklmnopqrstuvwxyz123456";
    const rpc = new PiRpcProcess({
      cwd: directory,
      args: [
        "--no-extensions",
        "--extension",
        resolve("server/extensions/inspire-branch-bridge.ts"),
        "--extension",
        hookExtension,
        "--session-dir",
        sessionDir,
        "--session",
        sessionFile,
      ],
      env: {
        PI_CODING_AGENT_DIR: join(directory, "config"),
        PI_CODING_AGENT_SESSION_DIR: sessionDir,
        PI_OFFLINE: "1",
        INSPIRE_BRANCH_COMMAND: command,
        INSPIRE_BRANCH_STATUS_KEY: statusKey,
        INSPIRE_BRANCH_WORKER_ID: workerId,
      },
    });
    const statuses: Array<Record<string, unknown>> = [];
    let promptResolved = false;
    let statusBeforePromptFence = false;
    const dialogs: Array<Record<string, unknown>> = [];
    rpc.on("event", (event) => {
      const record = event as Record<string, unknown>;
      if (
        record.type === "extension_ui_request" &&
        record.method === "setStatus" &&
        record.statusKey === statusKey
      ) {
        statuses.push(record);
        if (!promptResolved) statusBeforePromptFence = true;
      } else if (
        record.type === "extension_ui_request" &&
        (record.method === "confirm" || record.method === "input")
      ) {
        dialogs.push(record);
        void rpc.sendExtensionUiResponse({
          id: record.id,
          ...(record.method === "confirm"
            ? { confirmed: true }
            : { value: "continue" }),
        });
      }
    });

    await rpc.start();
    try {
      const commands = await rpc.request<{
        commands: Array<Record<string, unknown>>;
      }>({ type: "get_commands" });
      expect(
        commands.commands.some(
          (item) => item.name === command || item.invocationName === command,
        ),
      ).toBe(true);
      const initial = await rpc.request<{
        entries: Array<Record<string, unknown>>;
        leafId: string | null;
      }>({ type: "get_entries" });
      const assistantOne = initial.entries.find(
        (entry) => textOf(entry) === "answer one",
      )!;
      const assistantThree = initial.entries.find(
        (entry) => textOf(entry) === "answer three",
      )!;
      const userThree = initial.entries.find(
        (entry) => textOf(entry) === "question three",
      )!;
      expect(assistantOne?.id).toBeTruthy();
      expect(assistantThree?.id).toBeTruthy();
      expect(userThree?.id).toBeTruthy();

      const navigate = async (
        sessionId: string,
        targetId: string,
        trustedTail: string,
      ) => {
        const nonce = `nonce_${statuses.length}_abcdefghijklmnopqrstuvwxyz123456`;
        const payload = Buffer.from(
          JSON.stringify({
            v: 1,
            nonce,
            workerId,
            sessionId,
            operation: "navigate",
            targetId,
          }),
        ).toString("base64url");
        promptResolved = false;
        await rpc.request({
          type: "prompt",
          message: `/${command} ${payload}`,
        });
        promptResolved = true;
        const event = statuses.at(-1)!;
        const result = JSON.parse(
          Buffer.from(String(event.statusText), "base64url").toString("utf8"),
        ) as Record<string, unknown>;
        expect(result).toMatchObject({
          v: 1,
          nonce,
          workerId,
          sessionId,
          ok: true,
          cancelled: false,
          effectiveLeaf: targetId,
        });
        const verified = await rpc.request<{
          entries: unknown[];
          leafId: string | null;
        }>({ type: "get_entries", since: trustedTail });
        expect(verified.entries).toEqual([]);
        expect(verified.leafId).toBe(targetId);
      };

      const trustedTail = String(initial.entries.at(-1)!.id);
      await navigate(SESSION_ID, String(assistantOne.id), trustedTail);
      await navigate(SESSION_ID, String(assistantThree.id), trustedTail);
      expect(statusBeforePromptFence).toBe(true);

      const forked = await rpc.request<{ text: string; cancelled: boolean }>({
        type: "fork",
        entryId: String(userThree.id),
      });
      expect(forked).toMatchObject({
        text: "question three",
        cancelled: false,
      });
      const state = await rpc.request<{
        sessionId: string;
        sessionFile: string;
      }>({ type: "get_state" });
      expect(state.sessionId).not.toBe(SESSION_ID);
      expect(resolve(state.sessionFile).startsWith(resolve(sessionDir))).toBe(
        true,
      );
      const afterForkCommands = await rpc.request<{
        commands: Array<Record<string, unknown>>;
      }>({ type: "get_commands" });
      expect(
        afterForkCommands.commands.some(
          (item) => item.name === command || item.invocationName === command,
        ),
      ).toBe(true);
      const forkEntries = await rpc.request<{
        entries: Array<Record<string, unknown>>;
        leafId: string | null;
      }>({ type: "get_entries" });
      const forkAssistantOne = forkEntries.entries.find(
        (entry) => textOf(entry) === "answer one",
      )!;
      await navigate(
        state.sessionId,
        String(forkAssistantOne.id),
        String(forkEntries.entries.at(-1)!.id),
      );
      expect(
        dialogs.filter((event) => event.method === "confirm"),
      ).toHaveLength(3);
      expect(dialogs.filter((event) => event.method === "input")).toHaveLength(
        1,
      );
    } finally {
      await rpc.stop();
    }
  }, 30_000);
});
