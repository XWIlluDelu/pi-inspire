import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../server/session-catalog.js";

const sessionId = "44444444-4444-4444-8444-444444444444";
const message = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-08-01T00:00:01.000Z",
  message:
    role === "user"
      ? { role, content: text, timestamp: 1 }
      : {
          role,
          content: [{ type: "text", text }],
          timestamp: 1,
          provider: "offline-tree",
          model: "offline",
          stopReason: "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
});

it("executes native root/custom navigation, summary append and cancellation, and endpoint-inclusive Clone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inspire-native-history-"));
  const sourcePath = join(directory, "source.jsonl");
  const configDir = join(directory, "config");
  const sessionDir = join(directory, "sessions");
  const hookPath = join(directory, "tree-hook.ts");
  await mkdir(configDir, { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", configDir);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", sessionDir);
  await writeFile(
    join(configDir, "settings.json"),
    JSON.stringify({ branchSummary: { skipPrompt: true } }),
  );
  let modelStarted = false;
  const modelServer = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* consume the local fixture request */
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        id: "history-summary",
        object: "chat.completion.chunk",
        created: 1,
        model: "offline",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Partial summary" },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    modelStarted = true; // Deliberately unfinished until native abort closes it.
  });
  await new Promise<void>((done) => modelServer.listen(0, "127.0.0.1", done));
  await writeFile(
    join(configDir, "models.json"),
    JSON.stringify({
      providers: {
        "offline-tree": {
          baseUrl: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`,
          api: "openai-completions",
          apiKey: "fixture-placeholder",
          models: [
            {
              id: "offline",
              name: "Local History fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    hookPath,
    `export default function (pi) {
    let visits = 0;
    pi.on("session_before_tree", (event) => {
      visits++;
      if (event.preparation.userWantsSummary && event.preparation.customInstructions !== "hold")
        return { summary: { summary: "Native carried work, hook visit " + visits, details: { readFiles: ["notes.md"] } }, label: "Carried work" };
    });
  }`,
  );
  const sourceBytes = `${[
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: directory,
    },
    message("u1", null, "user", "question one"),
    message("a1", "u1", "assistant", "answer one"),
    {
      type: "custom_message",
      id: "custom",
      parentId: "a1",
      timestamp: "2026-08-01T00:00:02.000Z",
      customType: "history-fixture",
      content: "extension input",
      display: true,
      details: { apiKey: "private fixture value" },
    },
    message("u2", "custom", "user", "question two"),
    message("a2", "u2", "assistant", "answer two"),
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;
  await writeFile(sourcePath, sourceBytes);
  const record: SessionRecord = {
    id: sessionId,
    path: sourcePath,
    cwd: directory,
    source: null,
    created: new Date(),
    modified: new Date(),
    messageCount: 5,
    firstMessage: "question one",
    searchText: "question one",
  };
  const catalog: SessionCatalogLike = {
    refresh: async () => [record],
    get: async (id) => (id === sessionId ? record : undefined),
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
        hookPath,
        "--model",
        "offline-tree/offline",
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
  const navigate = async (
    targetId: string,
    mode: "edit" | "switch",
    summarize = false,
    customInstructions?: string,
  ) => {
    const tree = await runtime.branchTree(sessionId);
    return runtime.navigateBranch({
      sessionId,
      revision: tree.revision,
      targetId,
      mode,
      summarize,
      customInstructions,
    });
  };
  try {
    await runtime.openSession(sessionId);
    await vi.waitFor(() => expect(workers[0]?.available).toBe(true), {
      timeout: 10000,
    });
    await workers[0]!.request({ type: "get_state" });
    expect((await runtime.branchTree(sessionId)).skipSummaryPrompt).toBe(true);
    const sourcePid = workers[0]!.pid;
    const beforeNavigation = await readFile(sourcePath, "utf8");
    const beforeCount = beforeNavigation.trim().split("\n").length;
    const root = await navigate("u1", "edit");
    expect(root.editorText).toBe("question one");
    expect(root.snapshot.active?.effectiveLeafId).toBeNull();
    expect(root.snapshot.active?.transcriptPage.messages).toEqual([]);
    const emptyTree = await runtime.branchTree(sessionId);
    const emptyClone = await runtime.cloneBranch({
      sessionId,
      revision: emptyTree.revision,
    });
    expect(emptyClone.editorText).toBe("");
    expect(emptyClone.snapshot.active?.transcriptPage.messages).toEqual([]);
    expect(
      (await readFile(emptyClone.snapshot.active!.sessionFile!, "utf8"))
        .trim()
        .split("\n"),
    ).toHaveLength(1);
    expect(workers[0]!.pid).toBe(sourcePid);
    await runtime.openSession(sessionId);
    await navigate("a2", "switch");
    const custom = await navigate("custom", "edit");
    expect(custom.editorText).toBe("extension input");
    expect(custom.snapshot.active?.effectiveLeafId).toBe("a1");
    await navigate("a2", "switch");
    expect(await readFile(sourcePath, "utf8")).toBe(beforeNavigation);

    const carried = await navigate(
      "u1",
      "edit",
      true,
      "Carry the earlier work",
    );
    expect(carried.editorText).toBe("question one");
    const appended = (await readFile(sourcePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .slice(beforeCount);
    expect(appended[0]).toMatchObject({
      type: "branch_summary",
      parentId: null,
      fromId: "a2",
      summary: "Native carried work, hook visit 5",
      fromHook: true,
    });
    expect(appended[1]).toMatchObject({
      type: "label",
      parentId: appended[0].id,
      targetId: appended[0].id,
      label: "Carried work",
    });
    expect(carried.snapshot.active?.effectiveLeafId).toBe(appended[1].id);

    const tree = await runtime.branchTree(sessionId);
    const cloned = await runtime.cloneBranch({
      sessionId,
      revision: tree.revision,
    });
    expect(cloned.editorText).toBe("");
    const clonedEntries = (
      await readFile(cloned.snapshot.active!.sessionFile!, "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(clonedEntries[0]).toMatchObject({
      id: cloned.sessionId,
      parentSession: sourcePath,
      cwd: directory,
    });
    expect(
      clonedEntries.slice(1).filter((entry) => entry.type !== "label"),
    ).toEqual([appended[0]]);
    expect(clonedEntries.at(-1)).toMatchObject({
      type: "label",
      targetId: appended[0].id,
      label: "Carried work",
    });
    expect(workers[0]!.pid).toBe(sourcePid);
    await runtime.openSession(sessionId);
    const beforeStop = await readFile(sourcePath, "utf8");
    const pending = navigate("a1", "switch", true, "hold");
    await vi.waitFor(() => expect(modelStarted).toBe(true), { timeout: 10000 });
    await runtime.abort(sessionId);
    await expect(pending).resolves.toMatchObject({
      cancelled: true,
      snapshot: { active: { effectiveLeafId: appended[1].id } },
    });
    expect(await readFile(sourcePath, "utf8")).toBe(beforeStop);
    expect(workers[0]!.pid).toBe(sourcePid);
    expect(workers[0]!.available).toBe(true);
    const again = await navigate(
      "a1",
      "switch",
      true,
      "Carry after cancellation",
    );
    expect(again.cancelled).not.toBe(true);
    const finished = (await readFile(sourcePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      finished.find(
        (entry) =>
          entry.type === "branch_summary" &&
          entry.summary.endsWith("hook visit 7"),
      ),
    ).toMatchObject({ parentId: "a1", fromId: appended[1].id });
    expect(workers[0]!.pid).toBe(sourcePid);
  } finally {
    await runtime.close();
    await attachments.close();
    modelServer.closeAllConnections();
    await new Promise<void>((done) => modelServer.close(() => done()));
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30000);
