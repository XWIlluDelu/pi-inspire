import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import {
  ModelMetadataCatalog,
  queryModelMetadata,
} from "../../server/model-metadata.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { SessionManager } from "../../server/pi-runtime.js";
import { RuntimeController } from "../../server/runtime.js";
import { SessionCatalog } from "../../server/session-catalog.js";
import { modelWorkflowFixture } from "./fixtures/model-workflow.js";

const roots: string[] = [];
function retainedRouter(cwd: string, sessions: string) {
  const manager = SessionManager.create(cwd, sessions);
  manager.appendModelChange("project-router", "auto");
  manager.appendThinkingLevelChange("high");
  manager.appendMessage({
    role: "user",
    content: "retained turn",
    timestamp: 1,
  });
  manager.appendMessage({
    role: "assistant",
    api: "openai-completions",
    provider: "project-native",
    model: "a",
    content: [{ type: "text", text: "Readable retained reply" }],
    timestamp: 2,
    stopReason: "stop",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  return manager;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("keeps healthy retained transcript and History readable when startup extension discovery fails, without guessing the selected model", async () => {
  const f = await modelWorkflowFixture();
  roots.push(f.root);
  const manager = retainedRouter(f.trusted, f.sessions);
  const path = manager.getSessionFile()!;
  const original = await readFile(path, "utf8");
  await writeFile(
    join(f.trusted, ".pi/extensions/project.ts"),
    'export default function () { throw new Error("Broken startup extension"); }',
  );
  const metadata = new ModelMetadataCatalog();
  const factory = vi.fn(() => {
    throw new Error("Pi startup unavailable");
  });
  const runtime = new RuntimeController(
    new SessionCatalog(f.trusted),
    new AttachmentStore(join(f.root, "uploads")),
    factory,
  ).setModelMetadataCatalog(metadata);
  try {
    const snapshot = await runtime.snapshot(manager.getSessionId());
    expect(snapshot.active).toMatchObject({
      model: null,
      availableModels: [],
      projectionHealth: { status: "ok" },
      transcriptPage: {
        messages: [
          { role: "user", content: "retained turn" },
          { role: "assistant", provider: "project-native", model: "a" },
        ],
      },
    });
    expect(snapshot.runState).toBe("idle");
    expect(factory).not.toHaveBeenCalled();
    const opened = await runtime.openSession(manager.getSessionId());
    expect(opened.active?.model).toBeNull();
    expect(opened.active?.transcriptPage.messages).toEqual(
      snapshot.active?.transcriptPage.messages,
    );
    expect((await runtime.branchTree(manager.getSessionId())).nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message", role: "assistant" }),
      ]),
    );
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(metadata.read(f.trusted)).rejects.toThrow(
      "Pi model extensions could not load",
    );
    expect(
      (await runtime.snapshot(manager.getSessionId())).active,
    ).toMatchObject({
      model: null,
      modelDiscovery: "unavailable",
      projectionHealth: { status: "ok" },
    });
  } finally {
    await runtime.close();
  }
});

it("opens retained transcript before deferred metadata and resolves New inheritance from that source without starting another worker", async () => {
  const f = await modelWorkflowFixture();
  roots.push(f.root);
  const manager = retainedRouter(f.trusted, f.sessions);
  const id = manager.getSessionId();
  const path = manager.getSessionFile()!;
  const original = await readFile(path, "utf8");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const query = vi.fn(async (cwd: string) => {
    await gate;
    return queryModelMetadata(cwd);
  });
  const metadata = new ModelMetadataCatalog(query);
  const attachments = new AttachmentStore(join(f.root, "uploads"));
  const factory = vi.fn(() => {
    throw new Error("Pi startup unavailable");
  });
  const runtime = new RuntimeController(
    new SessionCatalog(f.trusted),
    attachments,
    factory,
  ).setModelMetadataCatalog(metadata);
  try {
    const opened = await runtime.openSession(id);
    expect(opened.active).toMatchObject({
      model: null,
      modelDiscovery: "loading",
      projectionHealth: { status: "ok" },
      transcriptPage: { messages: [{ role: "user" }, { role: "assistant" }] },
    });
    expect(query).toHaveBeenCalledTimes(1);
    const inherited = runtime.refreshModels(id, true);
    release();
    const result = await inherited;
    expect(result.selection).toMatchObject({
      model: { provider: "project-router", id: "auto", virtual: true },
      thinkingLevel: "high",
    });
    expect((await runtime.snapshot(id)).active?.model).toEqual(
      result.selection?.model,
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readFile(f.events, "utf8")).not.toMatch(
      /session_start|agent_start|request|route/,
    );
  } finally {
    release();
    await runtime.close();
    await query.mock.results[0]?.value.catch(() => undefined);
    await attachments.close();
  }
});

it("keeps native virtual selection/effort across replies, real navigation, copies and read-only recovery while context remains physical", async () => {
  const f = await modelWorkflowFixture();
  roots.push(f.root);
  const attachments = new AttachmentStore(join(f.root, "uploads"));
  const catalog = new SessionCatalog(f.trusted);
  const metadata = new ModelMetadataCatalog();
  const workers: PiRpcProcess[] = [];
  const makeRuntime = () =>
    new RuntimeController(catalog, attachments, (options) => {
      const worker = new PiRpcProcess({
        ...options,
        args: [
          "--no-tools",
          "--no-skills",
          "--no-context-files",
          "--no-prompt-templates",
          "--no-themes",
          ...(options.args ?? []),
        ],
      });
      workers.push(worker);
      return worker;
    }).setModelMetadataCatalog(metadata);
  let runtime = makeRuntime();
  const selected = { provider: "project-router", id: "auto", virtual: true };
  const settle = async (id: string) => {
    await vi.waitFor(
      async () => expect((await runtime.snapshot(id)).runState).toBe("idle"),
      { timeout: 10_000 },
    );
    return (await runtime.snapshot(id)).active!;
  };
  try {
    const created = await runtime.newSession(f.trusted, {
      model: selected,
      thinkingLevel: "high",
    });
    const id = created.active!.sessionId;
    expect(created.active!.model).toMatchObject({
      ...selected,
      thinkingLevelMap: { low: "low", medium: null, high: "high" },
    });
    expect(created.active!.thinkingLevel).toBe("high");
    expect((await runtime.snapshot(id)).active?.thinkingLevel).toBe("high");
    const path = created.active!.sessionFile!;
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    await runtime.prompt({ sessionId: id, message: "first routed turn" });
    const first = await settle(id);
    expect(first.model).toMatchObject(selected);
    expect(first.thinkingLevel).toBe("high");
    expect(first.stats).toMatchObject({
      contextUsage: { tokens: 1010, contextWindow: 16_000 },
    });
    const worker = workers[0]!;
    expect(
      await worker.request({ type: "get_available_thinking_levels" }),
    ).toEqual({ levels: ["low", "high"] });
    const entries = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const firstReply = entries.find(
      (entry) => entry.message?.role === "assistant",
    );
    expect(firstReply.message).toMatchObject({
      provider: "project-native",
      model: "a",
      thinkingLevel: "medium",
    });
    await runtime.setThinkingLevel(id, "low");
    await runtime.prompt({ sessionId: id, message: "second routed turn" });
    const second = await settle(id);
    expect(second.model).toMatchObject(selected);
    expect(second.thinkingLevel).toBe("low");
    expect(second.stats).toMatchObject({
      contextUsage: { tokens: 2010, contextWindow: 64_000 },
    });

    const tree = await runtime.branchTree(id);
    const navigated = await runtime.navigateBranch({
      sessionId: id,
      revision: tree.revision,
      targetId: firstReply.id,
      mode: "switch",
    });
    const nativeState = await worker.request<{ thinkingLevel: string }>({
      type: "get_state",
    });
    expect(nativeState.thinkingLevel).toBe("low");
    expect(navigated.snapshot.active).toMatchObject({
      model: selected,
      thinkingLevel: nativeState.thinkingLevel,
      navigationLeased: true,
      effectiveLeafId: firstReply.id,
    });
    expect((await runtime.snapshot(id)).active).toMatchObject({
      model: selected,
      thinkingLevel: nativeState.thinkingLevel,
      navigationLeased: true,
    });
    await runtime.prompt({ sessionId: id, message: "continue earlier route" });
    const continued = await settle(id);
    expect(continued.model).toMatchObject(selected);
    expect(continued.navigationLeased).toBe(false);
    expect(continued.stats).toMatchObject({
      contextUsage: { contextWindow: 64_000 },
    });

    const copyTree = await runtime.branchTree(id);
    const retained = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const latestUser = retained
      .filter((entry) => entry.message?.role === "user")
      .at(-1);
    const fork = await runtime.forkBranch({
      sessionId: id,
      revision: copyTree.revision,
      targetId: latestUser.id,
    });
    // The file-backed copy opens before registration discovery; resolve its
    // selected identity through the same addressed query used by New.
    expect(
      (await runtime.refreshModels(fork.sessionId, true)).selection?.model,
    ).toMatchObject(selected);
    await runtime.prompt({
      sessionId: fork.sessionId,
      message: fork.editorText!,
    });
    expect((await settle(fork.sessionId)).model).toMatchObject(selected);
    const latestTree = await runtime.branchTree(id);
    const clone = await runtime.cloneBranch({
      sessionId: id,
      revision: latestTree.revision,
      targetId: continued.effectiveLeafId!,
    });
    expect(clone.snapshot.active?.model).toMatchObject(selected);
    await runtime.prompt({
      sessionId: clone.sessionId,
      message: "continue cloned router",
    });
    const cloned = await settle(clone.sessionId);
    expect(cloned.model).toMatchObject(selected);
    expect(cloned.stats).toMatchObject({
      contextUsage: { contextWindow: 16_000 },
    });

    const nativeDefault = await runtime.newSession(f.trusted);
    expect(nativeDefault.active).toMatchObject({
      model: selected,
      thinkingLevel: "low",
    });
    await runtime.close();
    expect(workers.every((worker) => worker.pid === null)).toBe(true);
    metadata.invalidate();
    runtime = makeRuntime();
    const workerCount = workers.length;
    const initialReadonly = await runtime.snapshot(id);
    expect(initialReadonly.active).toMatchObject({
      model: null,
      modelDiscovery: "loading",
    });
    const inherited = await runtime.refreshModels(id, true);
    const readonly = await runtime.snapshot(id);
    expect(readonly.active?.model).toMatchObject(selected);
    expect(inherited.selection?.model).toEqual(readonly.active?.model);
    expect(readonly.active?.thinkingLevel).toBe("high");
    expect(workers).toHaveLength(workerCount);
    // Native recovery only retains the virtual choice while its definition is
    // registered. Removing it restores the last physical response, not the
    // unavailable model_change identity.
    const projectExtension = join(f.trusted, ".pi/extensions/project.ts");
    await writeFile(
      projectExtension,
      (await readFile(projectExtension, "utf8")).replace(
        '"project");',
        '"project", false);',
      ),
    );
    metadata.invalidate();
    await runtime.refreshModels(id, true);
    expect((await runtime.snapshot(id)).active?.model).toEqual({
      provider: "project-native",
      id: "b",
    });
    expect(workers).toHaveLength(workerCount);
  } finally {
    await runtime.close();
    await attachments.close();
  }
}, 45_000);
