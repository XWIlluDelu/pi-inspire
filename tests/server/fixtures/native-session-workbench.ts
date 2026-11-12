import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { createInspireServer } from "../../../server/app.js";
import { AttachmentStore } from "../../../server/attachments.js";
import { GitInspectionService } from "../../../server/git-inspection.js";
import { PiRpcProcess } from "../../../server/pi-rpc.js";
import { piInstallation } from "../../../server/pi-runtime.js";
import { PreferencesStore } from "../../../server/preferences.js";
import { ResourceStore } from "../../../server/resources.js";
import { RuntimeController } from "../../../server/runtime.js";
import type { SessionRecord } from "../../../server/session-catalog.js";
import { nativePiWorkspace, stubNativePiEnvironment } from "./native-pi.js";
import { listenOnLoopback, writeOfflineModels } from "./offline-model.js";
import { catalog as sessionCatalog } from "./runtime.js";

export async function nativeSessionWorkbench(
  cleanup: Array<() => Promise<unknown>>,
  { openSource = true, extraExtensions = [] as readonly string[] } = {},
) {
  const {
    root: directory,
    cwd: workspace,
    sessions,
    agent,
    env,
  } = await nativePiWorkspace("inspire-native-workbench-", {
    defaultProvider: "export-fixture",
    defaultModel: "offline",
    defaultThinkingLevel: "off",
    defaultProjectTrust: "never",
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  stubNativePiEnvironment(env);
  await writeOfflineModels(agent, "http://127.0.0.1:1/v1", "export-fixture", [
    { id: "offline", input: ["text", "image"] },
  ]);
  const id = randomUUID();
  const path = join(sessions, `${id}.jsonl`);
  const timestamp = "2026-01-01T00:00:00.000Z";
  const entries = [
    {
      type: "model_change",
      id: "00000001",
      parentId: null,
      timestamp,
      provider: "export-fixture",
      modelId: "offline",
    },
    {
      type: "thinking_level_change",
      id: "00000002",
      parentId: "00000001",
      timestamp,
      thinkingLevel: "off",
    },
    {
      type: "message",
      id: "00000003",
      parentId: "00000002",
      timestamp,
      message: {
        role: "user",
        content: [
          { type: "text", text: "Shared prompt" },
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=",
          },
        ],
        timestamp: 1,
      },
    },
    {
      type: "message",
      id: "00000004",
      parentId: "00000003",
      timestamp,
      message: { role: "user", content: "Other branch only", timestamp: 2 },
    },
    {
      type: "message",
      id: "00000005",
      parentId: "00000003",
      timestamp,
      message: { role: "user", content: "Current branch only", timestamp: 3 },
    },
    {
      type: "custom",
      id: "00000006",
      parentId: "00000005",
      timestamp,
      customType: "fixture",
      data: { preserve: "metadata" },
    },
    {
      type: "message",
      id: "00000007",
      parentId: "00000006",
      timestamp,
      message: {
        role: "bashExecution",
        command: "printf fixture",
        output: "fixture",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: true,
        timestamp: 4,
      },
    },
  ];
  await writeFile(
    path,
    `${[{ type: "session", version: 3, id, cwd: workspace, timestamp }, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const record: SessionRecord = {
    id,
    path,
    cwd: workspace,
    source: null,
    created: new Date(timestamp),
    modified: new Date(timestamp),
    messageCount: 3,
    firstMessage: "Shared prompt",
  };
  const catalog = sessionCatalog([record]);
  const attachments = new AttachmentStore(join(directory, "uploads"));
  const workers: PiRpcProcess[] = [];
  const preferences = new PreferencesStore(join(directory, "prefs.json"));
  const runtime = new RuntimeController(catalog, attachments, {
    createProcess: (options) => {
      const worker = new PiRpcProcess({
        ...options,
        args: [
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--no-tools",
          "--no-approve",
          "--session-dir",
          sessions,
          "--model",
          "export-fixture/offline",
          "--thinking",
          "off",
          ...(options.args ?? []),
          ...extraExtensions.flatMap((path) => ["--extension", path]),
        ],
        env: { ...env, ...options.env },
      });
      workers.push(worker);
      return worker;
    },
  });
  const application = createInspireServer({
    token: "export-test-token",
    runtime,
    catalog,
    attachments,
    resources: new ResourceStore(),
    preferences,
    version: "0.0.0",
    piVersion: piInstallation.version,
    git: new GitInspectionService(),
  });
  cleanup.push(() => application.close());
  const url = await listenOnLoopback(application.server);
  const headers = {
    Authorization: "Bearer export-test-token",
    "Content-Type": "application/json",
  };
  if (openSource) {
    const selected = await fetch(`${url}/api/sessions/open`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id }),
    });
    expect(selected.status).toBe(200);
    await vi.waitFor(() => expect(workers[0]?.available).toBe(true), {
      timeout: 10_000,
    });
  }
  return {
    directory,
    workspace,
    id,
    path,
    runtime,
    workers,
    url,
    headers,
    catalog,
  };
}
