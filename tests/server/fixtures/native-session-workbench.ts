import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { createInspireServer } from "../../../server/app.js";
import { AttachmentStore } from "../../../server/attachments.js";
import { MockGitInspection } from "../../../server/mock.js";
import { PiRpcProcess } from "../../../server/pi-rpc.js";
import { piInstallation } from "../../../server/pi-runtime.js";
import { PreferencesStore } from "../../../server/preferences.js";
import { ResourceStore } from "../../../server/resources.js";
import { RuntimeController } from "../../../server/runtime.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../../server/session-catalog.js";
import { isolatedTestEnvironment } from "./isolated-environment.js";

export async function nativeSessionWorkbench(
  cleanup: Array<() => Promise<unknown>>,
  { openSource = true, workspaceName = "workspace" } = {},
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-export-test-")),
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "home"),
    config = join(directory, "config"),
    sessions = join(directory, "sessions"),
    workspace = join(directory, workspaceName),
    temporary = join(directory, "tmp");
  await Promise.all(
    [home, config, sessions, workspace, temporary].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const environment = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    PI_CODING_AGENT_DIR: config,
    PI_CODING_AGENT_SESSION_DIR: sessions,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  for (const [name, value] of Object.entries(environment))
    vi.stubEnv(name, value);
  await writeFile(join(config, "auth.json"), "{}\n");
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({
      defaultProvider: "export-fixture",
      defaultModel: "offline",
      defaultThinkingLevel: "off",
      defaultProjectTrust: "never",
      enableInstallTelemetry: false,
      packages: [],
      extensions: [],
      prompts: [],
      skills: [],
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );
  await writeFile(
    join(config, "models.json"),
    JSON.stringify({
      providers: {
        "export-fixture": {
          api: "openai-completions",
          apiKey: "synthetic",
          baseUrl: "http://127.0.0.1:1/v1",
          models: [
            {
              id: "offline",
              reasoning: false,
              input: ["text", "image"],
              contextWindow: 8192,
              maxTokens: 128,
            },
          ],
        },
      },
    }),
  );
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
  const catalog: SessionCatalogLike = {
    refresh: async () => [record],
    get: async (key) => (key === id ? record : undefined),
    list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
    listByIds: async () => [],
    listByCwds: async () => [],
    invalidate() {},
  };
  const attachments = new AttachmentStore(join(directory, "uploads"));
  const workers: PiRpcProcess[] = [];
  const preferences = new PreferencesStore(join(directory, "prefs.json"));
  const terminalStore = {
    has: async (id: string) =>
      (await preferences.read()).terminalSessionIds.includes(id),
    set: (id: string, value: boolean) =>
      preferences.setTerminalSession(id, value),
  };
  const runtime = new RuntimeController(catalog, attachments, (options) => {
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
      ],
      env: isolatedTestEnvironment(directory, {
        ...options.env,
        ...environment,
      }),
    });
    workers.push(worker);
    return worker;
  });
  runtime.setTerminalSessionStore(terminalStore);
  const application = createInspireServer({
    token: "export-test-token",
    runtime,
    catalog,
    attachments,
    resources: new ResourceStore(),
    preferences,
    version: "0.0.0",
    piVersion: piInstallation.version,
    git: new MockGitInspection(),
    mock: false,
  });
  cleanup.push(() => application.close());
  await new Promise<void>((ready) =>
    application.server.listen(0, "127.0.0.1", ready),
  );
  const url = `http://127.0.0.1:${(application.server.address() as AddressInfo).port}`;
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
    terminalStore,
    environment,
  };
}
