import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import { SessionCatalog } from "../../server/session-catalog.js";
import { savedAssistant } from "../fixtures/history-session.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";
import {
  startOfflineModel,
  writeOfflineModels,
} from "./fixtures/offline-model.js";
import { deferredSignal } from "./fixtures/runtime.js";
import { messageEntry, writeSession } from "./fixtures/session-jsonl.js";

const cleanups: Array<() => Promise<unknown>> = [];
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const MODEL = "fixture/offline";
const REPLY = "Partial model reply";

function messages() {
  return [
    message("u1", null, "user", "question one", 1),
    message("a1", "u1", "assistant", "answer one", 2),
    message("u2", "a1", "user", "question two", 3),
    message("a2", "u2", "assistant", "answer two", 4),
  ];
}

function readEntries(bytes: string) {
  return bytes
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function heldModel(agent: string) {
  const started = deferredSignal();
  const release = deferredSignal();
  const model = await startOfflineModel({
    reply: REPLY,
    beforeFinish: () => {
      started.resolve();
      return release.promise;
    },
  });
  cleanups.push(async () => {
    release.resolve();
    await model.close();
  });
  await writeOfflineModels(agent, model.baseUrl, "fixture", [
    {
      id: "offline",
      name: "Offline model",
      contextWindow: 32768,
      maxTokens: 1024,
    },
  ]);
  return { started: started.promise, finish: release.resolve };
}

function message(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
  timestamp: number,
) {
  return messageEntry(
    id,
    parentId,
    role === "user"
      ? { role, content: text, timestamp }
      : savedAssistant(text, { provider: "test", model: "test", timestamp }),
  );
}

async function fixture(
  entries: readonly unknown[],
  { extension, stream = false }: { extension?: string; stream?: boolean } = {},
) {
  const f = await nativePiWorkspace("inspire-native-branch-", {
    branchSummary: { skipPrompt: true },
    defaultProjectTrust: "never",
    compaction: { enabled: false },
    cacheWarming: "off",
    retry: { enabled: false },
  });
  cleanups.push(() => rm(f.root, { recursive: true, force: true }));
  stubNativePiEnvironment(f.env);
  const model = stream ? await heldModel(f.agent) : undefined;
  const path = join(f.sessions, "source.jsonl");
  await writeSession(path, f.cwd, SESSION_ID, entries);
  const source = await readFile(path, "utf8");
  if (extension) {
    const extensions = join(f.agent, "extensions");
    await mkdir(extensions);
    await writeFile(join(extensions, "hooks.ts"), extension);
  }
  const attachments = new AttachmentStore(join(f.root, "uploads"));
  const workers: PiRpcProcess[] = [];
  cleanups.push(() => attachments.close());
  const runtime = new RuntimeController(
    new SessionCatalog(f.cwd),
    attachments,
    {
      createProcess: (options) => {
        const worker = new PiRpcProcess({
          ...options,
          env: { ...f.env, ...options.env, PI_ATTACH_CONTROL: "0" },
          args: [
            "--session-dir",
            f.sessions,
            ...(options.args ?? []),
            ...(stream ? ["--model", MODEL] : []),
          ],
        });
        workers.push(worker);
        return worker;
      },
    },
  );
  cleanups.push(() => runtime.close());
  let ready = false;
  runtime.on("event", (event) => {
    if (event.type === "runtime_ready" && event.sessionId === SESSION_ID)
      ready = true;
  });
  async function open() {
    await runtime.openSession(SESSION_ID);
    await runtime.setRuntimeSetting(SESSION_ID, {
      key: "steeringMode",
      value: "one-at-a-time",
    });
    await vi.waitFor(() => expect(ready).toBe(true), { timeout: 10_000 });
  }
  async function navigate(
    targetId: string,
    mode: "edit" | "switch",
    summarize = false,
    customInstructions?: string,
  ) {
    return runtime.navigateBranch({
      sessionId: SESSION_ID,
      revision: (await runtime.snapshot(SESSION_ID)).active!.branchRevision!,
      targetId,
      mode,
      summarize,
      customInstructions,
    });
  }
  async function copy(kind: "fork" | "clone", targetId: string | null) {
    const address = {
      sessionId: SESSION_ID,
      viewId: (await runtime.snapshot(SESSION_ID)).active!.transcriptPage
        .viewId,
    };
    return kind === "fork"
      ? runtime.forkBranch({ ...address, targetId: targetId! })
      : runtime.cloneBranch({ ...address, targetId });
  }
  return {
    ...f,
    path,
    source,
    runtime,
    attachments,
    workers,
    model,
    open,
    navigate,
    copy,
  };
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  vi.unstubAllEnvs();
  if (failures.length) throw new AggregateError(failures);
});

describe("native Pi History and branch workflows", () => {
  it.each(["user", "custom_message"] as const)(
    "restores the exact saved %s position before opening the next worker",
    async (type) => {
      const { path, source, runtime, workers, open, navigate } = await fixture([
        {
          type: "thinking_level_change",
          id: "thinking",
          parentId: null,
          timestamp: new Date(0).toISOString(),
          thinkingLevel: "off",
        },
        message("root", "thinking", "user", "Root question", 1),
        message("older", "root", "assistant", "Root answer", 2),
        type === "user"
          ? message("saved", "older", "user", "Unanswered question", 3)
          : {
              type,
              id: "saved",
              parentId: "older",
              timestamp: new Date(3).toISOString(),
              customType: "saved-note",
              content: "Saved extension message",
              display: true,
            },
      ]);
      await open();
      const earlier = await navigate("older", "switch");
      expect(earlier.snapshot.active).toMatchObject({
        durableLeafId: "saved",
        effectiveLeafId: "older",
        restoreSavedLeafId: "saved",
      });
      const restored = await navigate("saved", "switch");
      expect(restored.editorText).toBeUndefined();
      expect(restored.snapshot.active).toMatchObject({
        effectiveLeafId: "saved",
        restoreSavedLeafId: null,
      });
      expect(workers).toHaveLength(1);
      expect(workers[0]!.available).toBe(false);
      await runtime.setRuntimeSetting(SESSION_ID, {
        key: "autoRetryEnabled",
        value: false,
      });
      expect(workers).toHaveLength(2);
      expect(await workers[1]!.request({ type: "get_entries" })).toMatchObject({
        leafId: "saved",
      });
      expect(await readFile(path, "utf8")).toBe(source);
    },
    15_000,
  );

  it("isolates source navigation dialogs from shell delivery and fork destinations", async () => {
    const { runtime, workers, path, open, navigate, copy } = await fixture(
      [
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
      ],
      {
        extension: `
export default function (pi) {
  pi.registerCommand("fixture-visible", { handler: async () => {} });
  let recorded = false;
  pi.on("session_before_tree", async (_event, ctx) => {
    if (!await ctx.ui.confirm("Navigate branch?", "Confirm tree navigation")) return { cancel: true };
  });
  pi.on("session_tree", async (event, ctx) => {
    if (recorded || event.newLeafId !== "a1" || ctx.sessionManager.getSessionId() !== ${JSON.stringify(SESSION_ID)}) return;
    recorded = true;
    pi.sendMessage({ customType: "branch-note", content: "Branch selected", display: true }, { triggerTurn: false });
    await ctx.ui.confirm("Callback appended", "Finish navigation?");
    pi.appendEntry("branch-complete", { leaf: event.newLeafId });
  });
  pi.on("session_before_fork", async (_event, ctx) => {
    if (await ctx.ui.input("Fork branch?", "Type continue") !== "continue") return { cancel: true };
  });
}
`,
      },
    );
    const dialogs: Array<Record<string, unknown>> = [];
    const responses: Promise<void>[] = [];
    const navigationDialog = deferredSignal();
    let holdNavigation = true;
    runtime.on("event", (event) => {
      const record = event as Record<string, unknown>;
      if (
        record.type !== "extension_ui_request" ||
        (record.method !== "confirm" && record.method !== "input")
      )
        return;
      dialogs.push(record);
      if (holdNavigation) {
        navigationDialog.resolve();
        return;
      }
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
    await open();
    const [command] = (
      await workers[0]!.request<{ commands: { name: string }[] }>({
        type: "get_commands",
      })
    ).commands
      .map(({ name }) => name)
      .filter((name) => name.startsWith("inspire_branch_"))
      .sort((a, b) => a.length - b.length);
    expect(command).toBeDefined();
    const snapshot = await runtime.snapshot(SESSION_ID);
    expect(snapshot.active?.commands).toContainEqual(
      expect.objectContaining({ name: "fixture-visible" }),
    );
    expect(snapshot.active?.commands).not.toContainEqual(
      expect.objectContaining({ name: command }),
    );
    for (const suffix of [" forged", "\tforged", "\nforged", ""]) {
      await expect(
        runtime.prompt({
          sessionId: SESSION_ID,
          message: `/${command}${suffix}`,
        }),
      ).rejects.toMatchObject({ status: 403 });
    }
    const navigating = navigate("a1", "switch");
    // Wait for the real extension event within this integration case's budget,
    // and expose navigation errors instead of masking them as a polling timeout.
    await Promise.race([
      navigationDialog.promise,
      navigating.then(() => {
        throw new Error("Navigation completed without its confirmation dialog");
      }),
    ]);
    expect(dialogs).toHaveLength(1);
    const shellRequests = vi.spyOn(workers[0]!, "request");
    try {
      await expect(
        runtime.prompt({
          sessionId: SESSION_ID,
          message: "!echo rejected-during-navigation",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        shellRequests.mock.calls.some(([command]) => command.type === "bash"),
      ).toBe(false);
    } finally {
      holdNavigation = false;
      const answer = {
        sessionId: SESSION_ID,
        id: dialogs[0]!.id,
        confirmed: true,
      };
      const answers = await Promise.allSettled([
        runtime.extensionUiResponse(answer),
        runtime.extensionUiResponse(answer),
      ]);
      expect(answers).toMatchObject([
        { status: "fulfilled" },
        { status: "rejected", reason: { status: 409 } },
      ]);
      shellRequests.mockRestore();
    }
    const { snapshot: selected } = await navigating;
    const [note, complete] = readEntries(await readFile(path, "utf8")).filter(
      (entry) => entry.customType?.startsWith("branch-"),
    );
    expect(note).toMatchObject({ type: "custom_message", parentId: "a1" });
    expect(complete).toMatchObject({
      type: "custom",
      parentId: note.id,
      customType: "branch-complete",
    });
    expect(selected.active).toMatchObject({
      effectiveLeafId: complete.id,
      projectionConflict: null,
    });
    expect(selected.sessionStatuses[SESSION_ID]?.runState).toBe("idle");
    expect(JSON.stringify(selected.active?.transcriptPage.messages)).toContain(
      "Branch selected",
    );
    await navigate("a2", "switch");
    const sourcePid = workers[0]?.pid;
    const forked = await copy("fork", "u2");
    expect(forked.snapshot.active?.sessionName).toBe("Named source");
    const destinationTree = (await runtime.snapshot(forked.sessionId)).active!;
    await runtime.navigateBranch({
      sessionId: forked.sessionId,
      revision: destinationTree.branchRevision!,
      targetId: "a1",
      mode: "switch",
    });
    await Promise.all(responses);
    await runtime.rename(SESSION_ID, "Still the same writable worker");
    expect(runtime.startupSessionHint).toBe(forked.sessionId);
    expect(workers).toHaveLength(2);
    expect(sourcePid).not.toBeNull();
    expect(workers[0]?.pid).toBe(sourcePid);
    expect(dialogs.filter((event) => event.method === "confirm")).toHaveLength(
      4,
    );
    expect(dialogs.filter((event) => event.method === "input")).toHaveLength(0);
  }, 30_000);

  it("opens and writes a first-turn fork after materializing its header-only Session", async () => {
    const { runtime, attachments, path, open, copy } = await fixture([
      {
        ...message("u1", null, "user", "question one", 1),
        message: {
          role: "user",
          timestamp: 1,
          content: [
            { type: "text", text: "question one" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ],
        },
      },
      message("a1", "u1", "assistant", "answer one", 2),
    ]);
    await open();
    const forked = await copy("fork", "u1");
    expect(forked.editorText).toBe("question one");
    expect(forked.snapshot.active?.transcriptPage.messages).toEqual([]);
    expect(forked.editorAttachments).toHaveLength(1);
    expect(
      (
        await attachments.imagePreview(forked.editorAttachments![0]!.id)
      ).bytes.toString("base64"),
    ).toBe("aW1hZ2U=");

    const destination = forked.snapshot.active!.sessionFile!;
    const records = readEntries(await readFile(destination, "utf8"));
    expect(records[0]).toMatchObject({
      type: "session",
      id: forked.sessionId,
      parentSession: path,
    });
    expect(records.some(({ type }) => type === "message")).toBe(false);

    await runtime.rename(forked.sessionId, "Writable root fork");
    const destinationText = await readFile(destination, "utf8");
    expect(destinationText).toContain('"name":"Writable root fork"');
    expect(destinationText).not.toContain("question one");
  }, 30_000);

  it("forks an active stock Pi run without interrupting its later completion", async () => {
    const { runtime, workers, model, open, navigate, copy } = await fixture(
      messages(),
      {
        stream: true,
      },
    );
    const events: Array<Record<string, unknown>> = [];
    runtime.on("event", (event) =>
      events.push(event as Record<string, unknown>),
    );
    await open();
    const staleTree = (await runtime.snapshot(SESSION_ID)).active!;
    expect((await navigate("a1", "switch")).snapshot.active).toMatchObject({
      effectiveLeafId: "a1",
      restoreSavedLeafId: "a2",
    });
    await expect(
      runtime.navigateBranch({
        sessionId: SESSION_ID,
        revision: staleTree.branchRevision!,
        targetId: "a2",
        mode: "switch",
      }),
    ).rejects.toThrow(/stale/);
    await runtime.prompt({
      sessionId: SESSION_ID,
      message: "active question",
    });
    const sourcePid = workers[0]?.pid;
    await model!.started;
    await vi.waitFor(async () =>
      expect(
        (await runtime.snapshot(SESSION_ID)).sessionStatuses[SESSION_ID]
          ?.runState,
      ).toBe("running"),
    );
    const sourceView = (await runtime.snapshot(SESSION_ID)).active!;
    const activePrompt = sourceView.transcriptPage.messages.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "user" &&
        JSON.stringify(message).includes("active question"),
    ) as { __inspireEntryId: string } | undefined;
    expect(activePrompt?.__inspireEntryId).toEqual(expect.any(String));
    const forked = await copy("fork", activePrompt!.__inspireEntryId);
    expect(forked.editorText).toBe("active question");
    const destinationText = await readFile(
      forked.snapshot.active!.sessionFile!,
      "utf8",
    );

    expect(forked.snapshot.sessionStatuses[forked.sessionId]?.runState).toBe(
      "idle",
    );
    expect(forked.snapshot.sessionStatuses[SESSION_ID]?.runState).toBe(
      "running",
    );
    expect(forked.snapshot.pendingQueues).toEqual({
      steering: [],
      followUp: [],
      totalCount: 0,
      revision: 0,
    });
    expect(workers).toHaveLength(1);
    expect(sourcePid).not.toBeNull();
    expect(workers[0]?.pid).toBe(sourcePid);
    expect(destinationText).not.toContain("active question");
    expect(destinationText).not.toContain(REPLY);
    expect(
      events.some(
        (event) =>
          event.type === "message_end" &&
          (event.message as { stopReason?: unknown } | undefined)
            ?.stopReason === "aborted",
      ),
    ).toBe(false);

    model!.finish();
    await vi.waitFor(
      async () =>
        expect(
          (await runtime.snapshot(SESSION_ID)).sessionStatuses[SESSION_ID]
            ?.runState,
        ).toBe("idle"),
      { timeout: 10_000 },
    );
    const source = (await runtime.snapshot(SESSION_ID)).active;
    expect(source?.restoreSavedLeafId).toBeNull();
    const transcript = JSON.stringify(source?.transcriptPage.messages);
    expect(transcript).toContain("active question");
    expect(transcript).toContain(REPLY);
    expect(transcript).not.toContain("answer two");
    expect(
      events.find(
        (event) =>
          event.sessionId === SESSION_ID &&
          event.type === "message_end" &&
          (event.message as { stopReason?: unknown } | undefined)
            ?.stopReason === "stop",
      ),
    ).toBeDefined();
  }, 30_000);

  it("executes native navigation, summary, Clone and both cancellation paths", async () => {
    const [u1, a1, u2, a2] = messages();
    const {
      runtime,
      workers,
      path: sourcePath,
      cwd,
      open,
      navigate,
      model,
      copy,
    } = await fixture(
      [
        u1,
        a1,
        {
          type: "custom_message",
          id: "custom",
          parentId: "a1",
          timestamp: new Date(3).toISOString(),
          customType: "history-fixture",
          content: "extension input",
          display: true,
        },
        { ...u2, parentId: "custom" },
        a2,
      ],
      {
        stream: true,
        extension: `export default function (pi) {
        pi.on("session_before_tree", (event) => {
          const { customInstructions, userWantsSummary } = event.preparation;
          if (customInstructions === "Refuse navigation") return { cancel: true };
          if (userWantsSummary && customInstructions !== "hold")
            return { summary: { summary: "Native carried work", details: { readFiles: ["notes.md"] } }, label: "Carried work" };
        });
      }`,
      },
    );
    await open();
    const sourcePid = workers[0]!.pid;
    const beforeNavigation = await readFile(sourcePath, "utf8");
    const beforeCount = readEntries(beforeNavigation).length;
    const root = await navigate("u1", "edit");
    expect(root.editorText).toBe("question one");
    expect(root.snapshot.active?.effectiveLeafId).toBeNull();
    expect(root.snapshot.active?.transcriptPage.messages).toEqual([]);
    const emptyClone = await copy("clone", null);
    expect(emptyClone.editorText).toBe("");
    expect(emptyClone.snapshot.active?.transcriptPage.messages).toEqual([]);
    expect(
      readEntries(
        await readFile(emptyClone.snapshot.active!.sessionFile!, "utf8"),
      ),
    ).toHaveLength(1);
    expect(workers[0]!.pid).toBe(sourcePid);
    await runtime.openSession(SESSION_ID);
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
    const appended = readEntries(await readFile(sourcePath, "utf8")).slice(
      beforeCount,
    );
    expect(appended[0]).toMatchObject({
      type: "branch_summary",
      parentId: null,
      fromId: "a2",
      summary: "Native carried work",
      fromHook: true,
    });
    expect(appended[1]).toMatchObject({
      type: "label",
      parentId: appended[0].id,
      targetId: appended[0].id,
      label: "Carried work",
    });
    expect(carried.snapshot.active?.effectiveLeafId).toBe(appended[1].id);

    const cloned = await copy("clone", appended[1].id);
    expect(cloned.editorText).toBe("");
    const clonedEntries = readEntries(
      await readFile(cloned.snapshot.active!.sessionFile!, "utf8"),
    );
    expect(clonedEntries[0]).toMatchObject({
      id: cloned.sessionId,
      parentSession: sourcePath,
      cwd,
    });
    expect(
      clonedEntries
        .slice(1)
        .filter((entry: { type: string }) => entry.type !== "label"),
    ).toEqual([appended[0]]);
    expect(clonedEntries.at(-1)).toMatchObject({
      type: "label",
      targetId: appended[0].id,
      label: "Carried work",
    });
    expect(workers[0]!.pid).toBe(sourcePid);
    await runtime.openSession(SESSION_ID);
    const beforeStop = await readFile(sourcePath, "utf8");
    const pending = navigate("a1", "switch", true, "hold");
    await model!.started;
    await runtime.abort(SESSION_ID);
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
    const finishedFile = await readFile(sourcePath, "utf8");
    const finished = readEntries(finishedFile);
    expect(
      finished
        .slice(appended.length + beforeCount)
        .find(
          (entry: { type: string; summary: string }) =>
            entry.type === "branch_summary" &&
            entry.summary === "Native carried work",
        ),
    ).toMatchObject({ parentId: "a1", fromId: appended[1].id });

    await expect(
      navigate("a2", "switch", true, "Refuse navigation"),
    ).resolves.toMatchObject({
      cancelled: true,
      snapshot: {
        active: { effectiveLeafId: again.snapshot.active!.effectiveLeafId },
      },
    });
    expect(await readFile(sourcePath, "utf8")).toBe(finishedFile);
    expect(workers[0]!.pid).toBe(sourcePid);
    expect(workers[0]!.available).toBe(true);
  }, 30_000);
});
