import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { PiActivityRecord } from "../../extensions/inspire-session-bridge.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { PiSessionActivity } from "../../server/pi-session-activity.js";
import { newBridgeIdentity } from "../../server/runtime-branch-bridge.js";
import type { SessionRecord } from "../../server/session-catalog.js";
import { nativePiWorkspace } from "./fixtures/native-pi.js";

it.each([false, true])(
  "observes standalone RPC but excludes the loaded GUI worker (managed=%s)",
  async (managed) => {
    const workspace = await nativePiWorkspace("inspire-native-activity-", {
      defaultProjectTrust: "never",
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    });
    const sessionId = randomUUID();
    const sessionFile = join(workspace.sessions, sessionId + ".jsonl");
    await writeFile(
      sessionFile,
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        cwd: workspace.cwd,
        timestamp: new Date().toISOString(),
      }) + "\n",
    );
    const directory =
      process.platform === "win32"
        ? join(
            workspace.root,
            "localappdata",
            "Inspire",
            "Cache",
            "pi-activity",
          )
        : process.platform === "darwin"
          ? join(workspace.root, "Library", "Caches", "Inspire", "pi-activity")
          : join(workspace.root, "cache", "inspire", "pi-activity");
    const records = async (): Promise<PiActivityRecord[]> => {
      const names = await readdir(directory).catch(() => []);
      return Promise.all(
        names
          .filter((name) => name.endsWith(".json"))
          .map(async (name) =>
            JSON.parse(await readFile(join(directory, name), "utf8")),
          ),
      );
    };
    const bridge = newBridgeIdentity();
    const rpc = new PiRpcProcess({
      cwd: workspace.cwd,
      env: {
        ...workspace.env,
        // A child can inherit its parent's environment without its GUI bridge.
        INSPIRE_BRANCH_COMMAND: bridge.command,
        INSPIRE_BRANCH_STATUS_KEY: bridge.statusKey,
        INSPIRE_BRANCH_WORKER_ID: bridge.workerId,
        INSPIRE_MODEL_FIXTURE_STREAM_DELAY_MS: "1500",
      },
      args: [
        "--session",
        sessionFile,
        "--provider",
        "global-native",
        "--model",
        "a",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-themes",
        "--no-tools",
        "--no-approve",
        "--extension",
        resolve("extensions/inspire-session-bridge.ts"),
        "--extension",
        resolve("tests/fixtures/pi-model-workflow-extension.ts"),
        "--extension",
        resolve("tests/fixtures/pi-operation-lifecycle-extension.ts"),
        ...(managed
          ? [
              "--extension",
              resolve("server/extensions/inspire-branch-bridge.ts"),
            ]
          : []),
      ],
    });
    const session: SessionRecord = {
      id: sessionId,
      path: sessionFile,
      cwd: workspace.cwd,
      created: new Date(),
      modified: new Date(),
      messageCount: 0,
      firstMessage: "",
      source: null,
    };
    const publish = vi.fn();
    const observer = new PiSessionActivity({
      directory,
      catalog: { refresh: async () => [session] },
      publish,
    });
    const observe = async (activity: PiActivityRecord["activity"]) => {
      await vi.waitFor(
        async () => {
          expect(await records()).toMatchObject([
            {
              sessionId,
              sessionFile,
              pid: rpc.pid,
              activity,
            },
          ]);
          await observer.refresh();
          expect(publish).toHaveBeenLastCalledWith({ [sessionId]: activity });
        },
        { timeout: 10_000, interval: 30 },
      );
    };
    let dialogId: string | undefined;
    rpc.on("event", (event: Record<string, unknown>) => {
      if (event.type === "extension_ui_request" && event.method === "confirm")
        dialogId = String(event.id);
    });
    try {
      await rpc.start();
      if (!managed) await observe("idle");
      else expect(await records()).toEqual([]);

      await rpc.request({
        type: "prompt",
        message: "Observe this local test turn.",
      });
      if (!managed) {
        await observe("working");
        await observe("idle");
        const waiting = rpc.request({ type: "prompt", message: "/await" });
        void waiting.catch(() => {});
        await observe("blocked");
        expect(dialogId).toBeDefined();
        await rpc.sendExtensionUiResponse({ id: dialogId!, confirmed: true });
        await waiting;
        await observe("idle");
      } else {
        await vi.waitFor(
          async () => {
            const state = await rpc.request<{ isStreaming: boolean }>({
              type: "get_state",
            });
            expect(state.isStreaming).toBe(true);
          },
          { timeout: 10_000 },
        );
        expect(await records()).toEqual([]);
        await vi.waitFor(
          async () => {
            const state = await rpc.request<{ isStreaming: boolean }>({
              type: "get_state",
            });
            expect(state.isStreaming).toBe(false);
          },
          { timeout: 10_000 },
        );
        expect(await records()).toEqual([]);
        await observer.refresh();
        expect(publish).toHaveBeenLastCalledWith({});
      }
      await rpc.stop();
      await observer.refresh();
      expect(publish).toHaveBeenLastCalledWith({});
    } finally {
      observer.close();
      await rpc.stop();
      await rm(workspace.root, { recursive: true, force: true });
    }
  },
  30_000,
);
