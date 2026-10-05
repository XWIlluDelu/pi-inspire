import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInspireServer } from "../../server/app.js";
import { AttachmentStore } from "../../server/attachments.js";
import { MockGitInspection } from "../../server/mock.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { piInstallation, SessionManager } from "../../server/pi-runtime.js";
import { PreferencesStore } from "../../server/preferences.js";
import { ResourceStore } from "../../server/resources.js";
import { RuntimeController } from "../../server/runtime.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../server/session-catalog.js";
import {
  assertExportDestination,
  serializeBranchExport,
} from "../../server/session-export.js";
import { exportArgumentPath } from "../../shared/commands.js";
import type { HostNativeCommandResponse } from "../../shared/contracts.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.unstubAllEnvs();
});

async function fixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-export-test-")),
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "home"),
    config = join(directory, "config"),
    sessions = join(directory, "sessions"),
    workspace = join(directory, "workspace"),
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
    searchText: "Shared prompt",
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
      env: {
        ...Object.fromEntries(
          Object.keys(process.env).map((key) => [key, undefined]),
        ),
        PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
        ...options.env,
        ...environment,
      },
    });
    workers.push(worker);
    return worker;
  });
  const application = createInspireServer({
    token: "export-test-token",
    runtime,
    catalog,
    attachments,
    resources: new ResourceStore(),
    preferences: new PreferencesStore(join(directory, "prefs.json")),
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
  const selected = await fetch(`${url}/api/sessions/open`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id }),
  });
  expect(selected.status).toBe(200);
  await vi.waitFor(() => expect(workers[0]?.available).toBe(true), {
    timeout: 10_000,
  });
  return { directory, workspace, id, path, runtime, workers, url, headers };
}

it.skipIf(
  !existsSync(join(piInstallation.packageRoot, "dist/core/session-export.js")),
)(
  "matches the installed native branch serializer and preserves the source through HTML/JSONL/downloads",
  async () => {
    const f = await fixture();
    const state = await f.workers[0]!.request({ type: "get_state" });
    const before = await readFile(f.path, "utf8");
    const native = (await import(
      pathToFileURL(
        join(piInstallation.packageRoot, "dist/core/session-export.js"),
      ).href
    )) as { serializeSessionBranch(manager: unknown): string };
    const expected = native.serializeSessionBranch(SessionManager.open(f.path));
    const rpc = vi.spyOn(f.workers[0]!, "request");
    const response = await fetch(`${f.url}/api/control/native-command`, {
      method: "POST",
      headers: f.headers,
      body: JSON.stringify({
        sessionId: f.id,
        command: "export",
        argument: '"exports/branch copy.jsonl"',
      }),
    });
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith({
      type: "get_entries",
      since: "00000007",
    });
    const result = (await response.json()) as HostNativeCommandResponse;
    expect(result.export).toMatchObject({
      format: "jsonl",
      fileName: "branch copy.jsonl",
    });
    const content = await readFile(
      join(f.workspace, "exports/branch copy.jsonl"),
      "utf8",
    );
    const parsed = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    const actual = parsed(content),
      reference = parsed(expected);
    expect({ ...actual[0], timestamp: null }).toEqual({
      ...reference[0],
      timestamp: null,
    });
    expect(actual.slice(1)).toEqual(reference.slice(1));
    expect(content).not.toContain("Other branch only");
    expect(content).toContain("image/png");
    expect(content).toContain("excludeFromContext");
    const download = `${f.url}/api/sessions/${f.id}/exports/${result.export!.downloadId}`;
    expect((await fetch(download)).status).toBe(401);
    expect(
      (
        await fetch(download.replace(f.id, "another-session"), {
          headers: f.headers,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${f.url}/api/sessions/${f.id}/exports/../../etc/passwd`, {
          headers: f.headers,
        })
      ).status,
    ).not.toBe(200);
    await writeFile(result.export!.path, "Replaced export file");
    const fetched = await fetch(download, { headers: f.headers });
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-disposition")).toContain("attachment;");
    expect(fetched.headers.get("content-security-policy")).toBe("sandbox");
    expect(await fetched.text()).toBe(content);
    const html = await fetch(`${f.url}/api/control/native-command`, {
      method: "POST",
      headers: f.headers,
      body: JSON.stringify({ sessionId: f.id, command: "export" }),
    });
    expect(html.status).toBe(200);
    const htmlResult = (await html.json()) as HostNativeCommandResponse;
    expect(htmlResult.export?.format).toBe("html");
    const htmlContent = await readFile(htmlResult.export!.path, "utf8");
    const embedded =
      /<script id="session-data" type="application\/json">([^<]+)<\/script>/u.exec(
        htmlContent,
      )?.[1];
    expect(embedded).toBeTruthy();
    const htmlData = Buffer.from(embedded!, "base64").toString("utf8");
    expect(htmlData).toContain("Other branch only");
    expect(htmlData).toContain("Current branch only");
    const workspaceFiles = await readdir(f.workspace, { recursive: true });
    for (const format of ["html", "jsonl"]) {
      const exported = await fetch(`${f.url}/api/sessions/export`, {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({ sessionId: f.id, format }),
      });
      expect(exported.status).toBe(200);
      const file = (await exported.json()) as {
        downloadId: string;
        fileName: string;
      };
      expect(file.fileName.endsWith(`.${format}`)).toBe(true);
      const downloaded = await fetch(
        `${f.url}/api/sessions/${f.id}/exports/${file.downloadId}`,
        { headers: f.headers },
      );
      expect(downloaded.status).toBe(200);
      const text = await downloaded.text();
      if (format === "jsonl")
        expect(parsed(text).slice(1)).toEqual(reference.slice(1));
      else {
        const data =
          /<script id="session-data" type="application\/json">([^<]+)<\/script>/u.exec(
            text,
          )?.[1];
        expect(Buffer.from(data!, "base64").toString("utf8")).toContain(
          "Other branch only",
        );
      }
    }
    expect(await readdir(f.workspace, { recursive: true })).toEqual(
      workspaceFiles,
    );
    expect(await readFile(f.path, "utf8")).toBe(before);
    expect(await f.workers[0]!.request({ type: "get_state" })).toEqual(state);
    const overwrite = await fetch(`${f.url}/api/control/native-command`, {
      method: "POST",
      headers: f.headers,
      body: JSON.stringify({
        sessionId: f.id,
        command: "export",
        argument: f.path,
      }),
    });
    expect(overwrite.status).toBe(400);
    expect(await readFile(f.path, "utf8")).toBe(before);
    const changelog = await fetch(`${f.url}/api/pi/changelog`, {
      headers: f.headers,
    });
    expect(await changelog.json()).toMatchObject({
      version: piInstallation.version,
      markdown: expect.stringContaining(`## [${piInstallation.version}]`),
    });
  },
  30_000,
);

it("exports native in-memory entries before a new session materializes", async () => {
  const f = await fixture();
  const snapshot = await f.runtime.newSession(f.workspace, {
    name: "Deferred export",
  });
  expect(existsSync(snapshot.active!.sessionFile!)).toBe(false);
  const result = await f.runtime.nativeCommand({
    sessionId: snapshot.active!.sessionId,
    command: "export",
    argument: "deferred.jsonl",
  });
  const exported = await readFile(result.export!.path, "utf8");
  expect(exported).toContain('"name":"Deferred export"');
  expect(exported).toContain(snapshot.active!.sessionId);
  expect(existsSync(snapshot.active!.sessionFile!)).toBe(false);
});

describe("native path and branch boundaries", () => {
  it("uses one native path token and rejects incomplete branch projections", () => {
    expect(exportArgumentPath()).toBeUndefined();
    expect(exportArgumentPath("report.jsonl extra ignored")).toBe(
      "report.jsonl",
    );
    expect(exportArgumentPath('"with space.jsonl" ignored')).toBe(
      "with space.jsonl",
    );
    expect(exportArgumentPath('"unfinished')).toBeUndefined();
    expect(() =>
      serializeBranchExport("id", "/tmp", { entries: [], leafId: "missing" }),
    ).toThrow("incomplete");
  });
  it("refuses canonical source paths, symlinks, and hardlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-export-path-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "session.jsonl");
    await writeFile(path, "source");
    await symlink(path, join(directory, "alias.jsonl"));
    await link(path, join(directory, "hard.jsonl"));
    for (const target of [
      path,
      join(directory, "alias.jsonl"),
      join(directory, "hard.jsonl"),
    ])
      await expect(assertExportDestination(target, path)).rejects.toThrow(
        "source Pi session",
      );
    await expect(
      assertExportDestination(join(directory, "export.jsonl"), path),
    ).resolves.toBeUndefined();
  });
});
