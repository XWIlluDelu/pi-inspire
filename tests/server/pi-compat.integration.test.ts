import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { loadSessionPreview } from "../../server/session-preview.js";

const directories: string[] = [];
const SOURCE_ID = "55555555-5555-4555-8555-555555555555";

function message(id: string, parentId: string | null, role: "user" | "assistant", text: string, timestamp: number) {
  return {
    type: "message", id, parentId, timestamp: new Date(timestamp).toISOString(),
    message: role === "user"
      ? { role, content: text, timestamp }
      : {
          role, content: [{ type: "text", text }], provider: "compat", model: "offline",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", timestamp,
        },
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inspire-pi-compat-"));
  directories.push(directory);
  const sessionDir = join(directory, "sessions");
  const sessionFile = join(directory, "source.jsonl");
  const extension = join(directory, "compat-extension.ts");
  const large = "compatibility context ".repeat(8_000);
  const entries = [
    message("u1", null, "user", "first compatibility question", 1),
    message("a1", "u1", "assistant", large, 2),
    message("u2", "a1", "user", "second compatibility question", 3),
    message("a2", "u2", "assistant", large, 4),
    message("u3", "a2", "user", "third compatibility question", 5),
    message("a3", "u3", "assistant", large, 6),
  ];
  await writeFile(sessionFile, `${[
    { type: "session", version: 3, id: SOURCE_ID, timestamp: "2026-08-01T00:00:00.000Z", cwd: directory },
    ...entries,
  ].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const configDir = join(directory, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "models.json"), JSON.stringify({
    providers: {
      "offline-compat": {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "non-secret-test-placeholder",
        models: [{ id: "offline-model", name: "Offline compatibility model", reasoning: false, input: ["text"], contextWindow: 131_072, maxTokens: 4_096 }],
      },
    },
  }));
  await writeFile(extension, `
export default function (pi) {
  pi.registerCommand("compat-probe", {
    description: "Exercise RPC extension UI without a model",
    handler: async (_args, ctx) => {
      const selected = await ctx.ui.select("Select", ["alpha", "beta"]);
      const confirmed = await ctx.ui.confirm("Confirm", "continue");
      const input = await ctx.ui.input("Input", "value");
      const edited = await ctx.ui.editor("Editor", "draft");
      ctx.ui.notify("compat-notify", "info");
      ctx.ui.setStatus("compat-status", "ready");
      ctx.ui.setWidget("compat-widget", ["line one", "line two"]);
      ctx.ui.setTitle("compat-title");
      ctx.ui.setEditorText("compat-editor-text");
      ctx.ui.setStatus("compat-result", JSON.stringify({ selected, confirmed, input, edited }));
    },
  });
  pi.on("session_before_compact", async (event) => ({
    compaction: {
      summary: "offline compatibility summary",
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    },
  }));
}
`);
  const create = (file = sessionFile) => new PiRpcProcess({
    cwd: directory,
    args: ["--no-extensions", "--extension", extension, "--session-dir", sessionDir, "--session", file],
    env: {
      PI_CODING_AGENT_DIR: configDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_OFFLINE: "1",
    },
  });
  return { directory, sessionDir, sessionFile, extension, entries, create };
}

describe("installed Pi 0.83 compatibility boundary", () => {
  it("keeps existing-session preview byte-preserving and checks RPC state/cursor/tree/model/command/stats", async () => {
    const { sessionFile, entries, create } = await fixture();
    const before = await readFile(sessionFile);
    const preview = await loadSessionPreview({
      path: sessionFile, id: SOURCE_ID, cwd: dirname(sessionFile), created: new Date(0), modified: new Date(0),
      messageCount: entries.length, firstMessage: "first compatibility question", searchText: "compatibility",
    });
    expect(preview.sessionId).toBe(SOURCE_ID);
    expect(await readFile(sessionFile)).toEqual(before);

    const rpc = create();
    await rpc.start();
    try {
      const state = await rpc.request<Record<string, unknown>>({ type: "get_state" });
      expect(state).toMatchObject({ sessionId: SOURCE_ID, sessionFile: resolve(sessionFile), isStreaming: false, isCompacting: false });

      const all = await rpc.request<{ entries: Array<Record<string, unknown>>; leafId: string | null }>({ type: "get_entries" });
      expect(all.entries.filter((entry) => typeof entry.id === "string" && ["u1", "a1", "u2", "a2", "u3", "a3"].includes(entry.id))).toHaveLength(entries.length);
      expect(all.leafId).toBeTruthy();
      const bounded = await rpc.request<{ entries: unknown[]; leafId: string | null }>({ type: "get_entries", since: all.leafId });
      expect(bounded).toEqual({ entries: [], leafId: all.leafId });
      await expect(rpc.request({ type: "get_entries", since: "missing-entry" })).rejects.toThrow(/not found/i);

      const tree = await rpc.request<{ tree: unknown[] }>({ type: "get_tree" });
      expect(tree.tree).toHaveLength(1);
      const models = await rpc.request<{ models: Array<Record<string, unknown>> }>({ type: "get_available_models" });
      expect(Array.isArray(models.models)).toBe(true);
      const commands = await rpc.request<{ commands: Array<{ name?: string; invocationName?: string }> }>({ type: "get_commands" });
      expect(commands.commands.some((command) => command.name === "compat-probe" || command.invocationName === "compat-probe")).toBe(true);
      const stats = await rpc.request<Record<string, unknown>>({ type: "get_session_stats" });
      expect(stats).toMatchObject({ sessionId: SOURCE_ID, sessionFile: resolve(sessionFile), userMessages: 3, assistantMessages: 3 });
    } finally {
      await rpc.stop();
    }
  }, 30_000);

  it("runs model selection, command UI, offline compaction, replacement, switch, and fork", async () => {
    const { sessionDir, sessionFile, create } = await fixture();
    const rpc = create();
    const uiEvents: Array<Record<string, unknown>> = [];
    let result: Record<string, unknown> | null = null;
    rpc.on("event", (event) => {
      const record = event as Record<string, unknown>;
      if (record.type !== "extension_ui_request") return;
      uiEvents.push(record);
      if (record.method === "select") rpc.sendExtensionUiResponse({ id: record.id, value: "beta" });
      if (record.method === "confirm") rpc.sendExtensionUiResponse({ id: record.id, confirmed: true });
      if (record.method === "input") rpc.sendExtensionUiResponse({ id: record.id, value: "typed" });
      if (record.method === "editor") rpc.sendExtensionUiResponse({ id: record.id, value: "edited" });
      if (record.method === "setStatus" && record.statusKey === "compat-result") result = JSON.parse(String(record.statusText));
    });
    await rpc.start();
    try {
      const models = await rpc.request<{ models: Array<{ provider: string; id: string }> }>({ type: "get_available_models" });
      expect(models.models.length).toBeGreaterThan(0);
      const selected = models.models[0]!;
      const model = await rpc.request<{ provider: string; id: string }>({ type: "set_model", provider: selected.provider, modelId: selected.id });
      expect(model).toMatchObject({ provider: selected.provider, id: selected.id });

      await rpc.request({ type: "prompt", message: "/compat-probe" });
      expect(result).toEqual({ selected: "beta", confirmed: true, input: "typed", edited: "edited" });
      expect(new Set(uiEvents.map((event) => event.method))).toEqual(new Set([
        "select", "confirm", "input", "editor", "notify", "setStatus", "setWidget", "setTitle", "set_editor_text",
      ]));

      const compacted = await rpc.request<Record<string, unknown>>({ type: "compact" }, 60_000);
      expect(compacted).toMatchObject({ summary: "offline compatibility summary" });
      const afterCompact = await rpc.request<{ entries: Array<Record<string, unknown>> }>({ type: "get_entries" });
      expect(afterCompact.entries.some((entry) => entry.type === "compaction")).toBe(true);

      const replacement = await rpc.request<{ cancelled: boolean }>({ type: "new_session", parentSession: sessionFile });
      expect(replacement.cancelled).toBe(false);
      const replacementState = await rpc.request<{ sessionId: string; sessionFile: string }>({ type: "get_state" });
      expect(replacementState.sessionId).not.toBe(SOURCE_ID);
      expect(resolve(replacementState.sessionFile).startsWith(resolve(sessionDir))).toBe(true);

      const switched = await rpc.request<{ cancelled: boolean }>({ type: "switch_session", sessionPath: sessionFile });
      expect(switched.cancelled).toBe(false);
      expect(await rpc.request<{ sessionId: string }>({ type: "get_state" })).toMatchObject({ sessionId: SOURCE_ID });

      const forked = await rpc.request<{ text: string; cancelled: boolean }>({ type: "fork", entryId: "u2" });
      expect(forked).toEqual({ text: "second compatibility question", cancelled: false });
      const forkState = await rpc.request<{ sessionId: string; sessionFile: string }>({ type: "get_state" });
      expect(forkState.sessionId).not.toBe(SOURCE_ID);
      expect(resolve(forkState.sessionFile)).not.toBe(resolve(sessionFile));
      expect((await readFile(forkState.sessionFile)).length).toBeGreaterThan(0);
    } finally {
      await rpc.stop();
    }
  }, 90_000);
});
