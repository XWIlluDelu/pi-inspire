import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import {
  ModelMetadataCatalog,
  queryModelMetadata,
} from "../../server/model-metadata.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import { SessionCatalog } from "../../server/session-catalog.js";
import { modelWorkflowFixture } from "./fixtures/model-workflow.js";
import { deferredSignal } from "./fixtures/runtime.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("keeps native virtual selection/effort across replies, real navigation, copies and read-only recovery while context remains physical", async () => {
  const f = await modelWorkflowFixture();
  roots.push(f.root);
  const attachments = new AttachmentStore(join(f.root, "uploads"));
  const catalog = new SessionCatalog(f.trusted);
  const metadataGate = deferredSignal();
  let cold = false;
  const query = vi.fn(async (cwd: string) => {
    if (cold) await metadataGate.promise;
    return queryModelMetadata(cwd);
  });
  const metadata = new ModelMetadataCatalog(query);
  const workers: PiRpcProcess[] = [];
  const makeRuntime = () =>
    new RuntimeController(catalog, attachments, {
      createProcess: (options) => {
        if (cold) throw new Error("Pi startup unavailable");
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
      },
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

    const retained = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const latestUser = retained
      .filter((entry) => entry.message?.role === "user")
      .at(-1);
    const fork = await runtime.forkBranch({
      sessionId: id,
      viewId: (await runtime.snapshot(id)).active!.transcriptPage.viewId,
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
    const clone = await runtime.cloneBranch({
      sessionId: id,
      viewId: (await runtime.snapshot(id)).active!.transcriptPage.viewId,
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
    const original = await readFile(path, "utf8");
    const modelCalls = async () =>
      (await readFile(f.events, "utf8"))
        .split("\n")
        .filter((line) =>
          /:(session_start|agent_start|request|route)$/.test(line),
        );
    const callsBefore = await modelCalls();
    metadata.invalidate();
    query.mockClear();
    cold = true;
    runtime = makeRuntime();
    const workerCount = workers.length;
    const initialReadonly = await runtime.openSession(id);
    expect(initialReadonly.active).toMatchObject({
      model: null,
      modelDiscovery: "loading",
      projectionHealth: { status: "ok" },
      transcriptPage: {
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "first routed turn" }],
          }),
          expect.objectContaining({
            role: "assistant",
            provider: "project-native",
          }),
        ]),
      },
    });
    const inheriting = runtime.refreshModels(id, true);
    metadataGate.resolve();
    const inherited = await inheriting;
    const readonly = await runtime.snapshot(id);
    expect(inherited.selection).toMatchObject({
      model: selected,
      thinkingLevel: "high",
    });
    expect(readonly.active).toMatchObject({
      model: inherited.selection?.model,
      thinkingLevel: "high",
    });
    expect(query).toHaveBeenCalledExactlyOnceWith(f.trusted);

    // A missing extension definition retires the saved router identity, but
    // keeps the physical response and all models that could still load.
    await writeFile(
      join(f.trusted, ".pi/extensions/project.ts"),
      'export default () => { throw new Error("Broken startup extension"); };',
    );
    expect(await runtime.refreshModels(id, true)).toMatchObject({
      warning:
        "Some Pi extensions could not load; their models may be unavailable.",
      selection: { model: { provider: "project-native", id: "b" } },
      models: expect.arrayContaining([
        expect.objectContaining({ provider: "global-native", id: "a" }),
      ]),
    });
    expect((await runtime.snapshot(id)).active?.projectionHealth.status).toBe(
      "ok",
    );
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await modelCalls()).toEqual(callsBefore);
    expect(workers).toHaveLength(workerCount);
  } finally {
    metadataGate.resolve();
    await runtime.close();
    await attachments.close();
  }
}, 45_000);
