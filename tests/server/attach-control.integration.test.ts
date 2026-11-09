import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachControlConnection,
  AttachControlRegistry,
} from "../../server/attach-control.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import { AttachmentStore } from "../../server/attachments.js";
import type { SessionRecord } from "../../server/session-catalog.js";
import { deleteSessionFile } from "../../server/session-delete.js";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const NAVIGATE = "tests/fixtures/pi-navigate-extension.ts";

/** A real Pi with attach-control loaded, as a user's terminal Pi would be. */
async function livePi(
  env: NodeJS.ProcessEnv = {},
  extensions: string[] = [],
  resume?: { id: string; sessionFile: string },
) {
  const root = await mkdtemp(join(tmpdir(), "attach-control-pi-"));
  cleanup.push(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const config = join(root, "config");
  const sessions = join(root, "sessions");
  const runtimeDir = env.XDG_RUNTIME_DIR ?? join(root, "run");
  await Promise.all(
    [config, sessions, runtimeDir].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  await writeFile(join(config, "auth.json"), "{}\n");
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({
      defaultProvider: "fixture",
      defaultModel: "offline",
      defaultThinkingLevel: "off",
      defaultProjectTrust: "never",
      enableInstallTelemetry: false,
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );
  await writeFile(
    join(config, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          apiKey: "synthetic",
          baseUrl: "http://127.0.0.1:1/v1",
          models: [
            {
              id: "offline",
              reasoning: true,
              contextWindow: 8192,
              maxTokens: 128,
            },
          ],
        },
      },
    }),
  );
  const id = resume?.id ?? randomUUID();
  const sessionFile = resume?.sessionFile ?? join(sessions, `${id}.jsonl`);
  const timestamp = "2026-01-01T00:00:00.000Z";
  const entries = [
    { type: "session", version: 3, id, timestamp, cwd: root },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp,
      message: { role: "user", content: "first", timestamp: 1 },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        api: "openai-completions",
        provider: "fixture",
        model: "offline",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ];
  if (!resume)
    await writeFile(
      sessionFile,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  const pi = new PiRpcProcess({
    cwd: root,
    args: [
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-tools",
      "--session",
      sessionFile,
      "--extension",
      resolve("extensions/attach-control.ts"),
      ...extensions.flatMap((path) => ["--extension", resolve(path)]),
    ],
    env: isolatedTestEnvironment(root, {
      PI_CODING_AGENT_DIR: config,
      PI_CODING_AGENT_SESSION_DIR: sessions,
      XDG_RUNTIME_DIR: runtimeDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      ...env,
    }),
  });
  await pi.start();
  cleanup.push(() => pi.stop());
  const registry = new AttachControlRegistry(
    join(runtimeDir, "pi-attach-control"),
  );
  return { pi, registry, id, sessionFile, root };
}

describe.skipIf(process.platform === "win32")("attach-control in Pi", () => {
  it("publishes presence and controls the live Pi through its socket", async () => {
    const { pi, registry, id, sessionFile } = await livePi({}, [NAVIGATE]);
    const [record] = await vi.waitFor(
      async () => {
        const found = await registry.forSession(id, sessionFile);
        expect(found).toHaveLength(1);
        return found;
      },
      { timeout: 15_000 },
    );
    // Pi records its startup model selection after the saved entries.
    expect(record).toMatchObject({ activity: "idle" });
    const startLeaf = record!.leafId;
    expect(typeof startLeaf).toBe("string");
    const connection = new AttachControlConnection(registry, record!);

    expect(await connection.read()).toMatchObject({
      status: "idle",
      leafId: startLeaf,
    });

    await connection.rename("Attached name");
    await vi.waitFor(
      async () =>
        expect(await readFile(sessionFile, "utf8")).toContain("Attached name"),
      { timeout: 5_000 },
    );

    expect((await connection.setThinkingLevel("high")).thinkingLevel).toBe(
      "high",
    );

    // The terminal user moves to another entry. The receiver checks the
    // submitted branch at the actual input/Stop boundary.
    await pi.request({ type: "prompt", message: "/test-navigate u1" });
    await vi.waitFor(
      async () =>
        expect(await connection.read()).toMatchObject({ leafId: null }),
      { timeout: 5_000 },
    );
    await expect(
      connection.prompt(
        "wrong context",
        undefined,
        undefined,
        undefined,
        startLeaf,
      ),
    ).rejects.toMatchObject({ code: "ATTACH_CONTROL_BRANCH_CHANGED" });
    await expect(connection.abort(startLeaf)).rejects.toMatchObject({
      code: "ATTACH_CONTROL_BRANCH_CHANGED",
    });

    // Reload replaces the extension instance; the binding follows the process.
    await connection.reload();
    await vi.waitFor(
      async () => {
        const [next] = await registry.forSession(id, sessionFile);
        expect(next?.instanceId).toBeDefined();
        expect(next?.instanceId).not.toBe(record!.instanceId);
      },
      { timeout: 15_000 },
    );
    expect(await connection.read()).toMatchObject({ status: "idle" });
  }, 60_000);

  it("ends every branch instance before trashing an unopened session, leaving other sessions running", async () => {
    const first = await livePi({}, ["docs/examples/native-ui.ts"]);
    const environment = { XDG_RUNTIME_DIR: join(first.root, "run") };
    const otherBranch = await livePi(
      { ...environment, PI_ATTACH_CONTROL_TAG: "other-branch" },
      [NAVIGATE],
      first,
    );
    const unrelated = await livePi(environment);
    const records = await vi.waitFor(
      async () => {
        const found = await first.registry.forSession(
          first.id,
          first.sessionFile,
        );
        expect(found).toHaveLength(2);
        return found;
      },
      { timeout: 15_000 },
    );
    const second = new AttachControlConnection(
      first.registry,
      records.find((record) => record.tag === "other-branch")!,
    );
    await otherBranch.pi.request({
      type: "prompt",
      message: "/test-navigate u1",
    });
    await vi.waitFor(
      async () => expect(await second.read()).toMatchObject({ leafId: null }),
      { timeout: 5_000 },
    );
    // One of the targets is blocked on a real native question.
    const asking = first.pi
      .request({ type: "prompt", message: "/ui-demo" })
      .catch(() => undefined);
    await vi.waitFor(
      async () =>
        expect(
          (await first.registry.forSession(first.id, first.sessionFile)).some(
            (record) => record.activity === "blocked",
          ),
        ).toBe(true),
      { timeout: 10_000 },
    );
    const { dev, ino, size, mtimeNs, ctimeNs } = await lstat(
      first.sessionFile,
      { bigint: true },
    );
    const session: SessionRecord = {
      id: first.id,
      path: first.sessionFile,
      cwd: first.root,
      source: { dev, ino, size, mtimeNs, ctimeNs },
      created: new Date(),
      modified: new Date(),
      messageCount: 2,
      firstMessage: "first",
    };
    const attachments = new AttachmentStore(join(first.root, "uploads"));
    const trash = join(first.root, "trashed.jsonl");
    const runtime = new RuntimeController(
      {
        get: async (id) => (id === first.id ? session : undefined),
        refresh: async () => [session],
        list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
        listByIds: async () => [],
        listByCwds: async () => [],
        invalidate() {},
      },
      attachments,
      undefined,
      undefined,
      undefined,
      undefined,
      (target, version) =>
        deleteSessionFile(
          target,
          async (payload) => {
            expect(
              await first.registry.forSession(first.id, first.sessionFile),
            ).toEqual([]);
            expect(
              await first.registry.forSession(
                unrelated.id,
                unrelated.sessionFile,
              ),
            ).toHaveLength(1);
            await rename(payload, trash);
          },
          undefined,
          version,
        ),
    ).setExternalSessionTerminator((id, path) =>
      first.registry.stopSession(id, path),
    );
    cleanup.push(() => attachments.close());
    cleanup.push(() => runtime.close());
    await expect(runtime.deleteSession(first.id)).resolves.toMatchObject({
      disposition: "trashed",
    });
    await asking;
    expect(await readFile(trash, "utf8")).toContain(first.id);
    await expect(readFile(first.sessionFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("rejects requests without the record's token", async () => {
    const { registry, id, sessionFile } = await livePi();
    const [record] = await vi.waitFor(
      async () => {
        const found = await registry.forSession(id, sessionFile);
        expect(found).toHaveLength(1);
        return found;
      },
      { timeout: 15_000 },
    );
    const { requestAttachControl } = await import(
      "../../extensions/attach-control.js"
    );
    expect(
      await requestAttachControl(record!.endpoint, {
        op: "state",
        token: "wrong",
      }),
    ).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
  }, 60_000);
});
