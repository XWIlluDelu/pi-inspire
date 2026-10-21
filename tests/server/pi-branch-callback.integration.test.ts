import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { SessionManager } from "../../server/pi-runtime.js";
import { RuntimeController } from "../../server/runtime.js";
import { SessionCatalog } from "../../server/session-catalog.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";

it.each(["custom", "custom_message"])(
  "attests a real session_tree %s callback chain and complete handler",
  async (effect) => {
    const f = await nativePiWorkspace("inspire-branch-effects-", {
      defaultProjectTrust: "never",
      compaction: { enabled: false },
      cacheWarming: "off",
      retry: { enabled: false },
    });
    stubNativePiEnvironment(f.env);
    const manager = SessionManager.create(f.cwd, f.sessions);
    const answer = (text: string) => ({
      role: "assistant" as const,
      api: "openai-completions" as const,
      provider: "test",
      model: "test",
      content: [{ type: "text" as const, text }],
      thinkingLevel: "off" as const,
      stopReason: "stop" as const,
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        totalTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    manager.appendMessage({
      role: "user",
      content: "question one",
      timestamp: 1,
    });
    const target = manager.appendMessage(answer("answer one"));
    manager.appendMessage({
      role: "user",
      content: "question two",
      timestamp: 3,
    });
    manager.appendMessage(answer("answer two"));
    const sessionId = manager.getSessionId(),
      path = manager.getSessionFile()!,
      extension = join(f.root, "effects.ts");
    await writeFile(
      extension,
      `export default pi => {
    pi.on("session_tree", async (event, ctx) => {
      ${
        effect === "custom"
          ? 'pi.appendEntry("branch-state", { leaf: event.newLeafId });'
          : 'pi.sendMessage({ customType: "branch-note", content: "Branch selected", display: true }, { triggerTurn: false });'
      }
      await ctx.ui.confirm("Callback appended", "Finish navigation?");
      pi.appendEntry("branch-complete", { leaf: event.newLeafId });
    });
  };`,
    );
    const attachments = new AttachmentStore(join(f.root, "uploads"));
    const workers: PiRpcProcess[] = [];
    const runtime = new RuntimeController(
      new SessionCatalog(f.cwd),
      attachments,
      (options) => {
        const worker = new PiRpcProcess({
          ...options,
          env: { ...options.env, ...f.env },
          args: ["--no-extensions", ...(options.args ?? []), "-e", extension],
        });
        workers.push(worker);
        return worker;
      },
    );
    const answers: Promise<void>[] = [];
    runtime.on("event", (event) => {
      const value = event as Record<string, unknown>;
      if (value.type === "extension_ui_request" && value.method === "confirm")
        answers.push(
          runtime.extensionUiResponse({
            sessionId,
            id: value.id,
            confirmed: true,
          }),
        );
    });
    try {
      await runtime.openSession(sessionId);
      const tree = await runtime.branchTree(sessionId);
      const result = await runtime.navigateBranch({
        sessionId,
        revision: tree.revision,
        targetId: target,
        mode: "switch",
      });
      await Promise.all(answers);
      expect(answers).toHaveLength(1);
      expect(workers).toHaveLength(1);
      expect(workers[0]!.available).toBe(true);
      expect(result.snapshot.active?.projectionConflict).toBeNull();
      const entries = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const delta = entries.filter((entry) =>
        entry.customType?.startsWith("branch-"),
      );
      expect(delta[0]).toMatchObject({ type: effect, parentId: target });
      expect(delta[1]).toMatchObject({
        type: "custom",
        parentId: delta[0].id,
        customType: "branch-complete",
      });
      expect(result.snapshot.active?.effectiveLeafId).toBe(delta[1].id);
      if (effect === "custom_message")
        expect(
          JSON.stringify(result.snapshot.active?.transcriptPage.messages),
        ).toContain("Branch selected");
      await runtime.rename(sessionId, "Still the same writable worker");
      expect(workers).toHaveLength(1);
    } finally {
      await runtime.close();
      await attachments.close();
      await rm(f.root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  20_000,
);
