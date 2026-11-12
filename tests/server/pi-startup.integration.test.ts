import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { piStartupDiagnostics } from "../../server/pi-startup-diagnostics.js";
import type { RuntimeController } from "../../server/runtime.js";
import { nativePiWorkspace } from "./fixtures/native-pi.js";
import { nativeSessionWorkbench } from "./fixtures/native-session-workbench.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  try {
    for (const close of cleanup.reverse()) await close();
  } finally {
    cleanup.length = 0;
    vi.unstubAllEnvs();
  }
});

async function fixture(extensionSource: string) {
  const extensions: string[] = [];
  const f = await nativeSessionWorkbench(cleanup, {
    openSource: false,
    extraExtensions: extensions,
  });
  const extension = join(f.directory, "startup.ts");
  await writeFile(extension, extensionSource);
  extensions.push(extension);
  const event = vi.fn();
  f.runtime.on("event", event);
  return { ...f, event, extension };
}

async function commitIdleRestart(runtime: RuntimeController) {
  const lease = await vi.waitFor(
    () => {
      const reserved = runtime.reserveMaintenanceRestart();
      if (reserved.kind !== "ready")
        throw new Error(`Waiting for restart admission: ${reserved.reason}`);
      return reserved;
    },
    { timeout: 10_000 },
  );
  expect(runtime.commitMaintenanceRestart(lease.leaseId).kind).toBe(
    "committed",
  );
}

it("attests native startup writes, keeps the worker usable, and admits an idle restart", async () => {
  const text = "x".repeat(32 * 1024);
  const f = await fixture(`
    export default function(pi) {
      pi.on("session_start", () => {
        pi.appendEntry("startup-state", { text: "x".repeat(32 * 1024) });
        for (let i = 0; i < 20; i++) pi.appendEntry("startup-item", { index: i });
        pi.setSessionName("Extension startup");
        pi.setThinkingLevel("high");
      });
    }
  `);
  await f.runtime.openSession(f.id);
  await vi.waitFor(
    () =>
      expect(f.event).toHaveBeenCalledWith(
        expect.objectContaining({ type: "runtime_ready", sessionId: f.id }),
      ),
    { timeout: 10_000 },
  );

  const entries: SessionEntry[] = (await readFile(f.path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    entries.find(
      (entry) =>
        entry.type === "custom" && entry.customType === "startup-state",
    ),
  ).toMatchObject({ data: { text } });
  expect(
    entries.filter(
      (entry) => entry.type === "custom" && entry.customType === "startup-item",
    ),
  ).toHaveLength(20);
  expect(entries).toContainEqual(
    expect.objectContaining({
      type: "session_info",
      name: "Extension startup",
    }),
  );

  const nativeState = await f.workers[0]!.request<{ thinkingLevel: string }>({
    type: "get_state",
  });
  expect(await f.runtime.snapshot(f.id)).toMatchObject({
    runState: "idle",
    active: { thinkingLevel: nativeState.thinkingLevel },
  });
  await expect(f.runtime.setThinkingLevel(f.id, "off")).resolves.toMatchObject({
    thinkingLevel: "off",
  });
  expect(f.workers).toHaveLength(1);
  await commitIdleRestart(f.runtime);
}, 20_000);

const startupDialog = `export default function(pi) {
  pi.on("session_start", async (_event, ctx) => {
    await ctx.ui.confirm("Fixture", "Startup confirmation");
  });
}`;

it("refuses a new session with a startup dialog and retires the provisional worker", async () => {
  const { runtime, workspace, workers } = await fixture(startupDialog);
  await expect(runtime.newSession(workspace)).rejects.toMatchObject({
    code: "PI_STARTUP_RESPONSE_UI_UNSUPPORTED",
    status: 503,
  });
  expect(runtime.activeSessionId).toBeNull();
  expect(runtime.ownWorkerTags()).toEqual(new Set());
  expect(workers[0]?.pid).toBeNull();
  await commitIdleRestart(runtime);
}, 15_000);

it.each([
  {
    failure: "a broken extension",
    source:
      'export default function() { throw new Error("private-native-token"); }',
    error: /Could not load Pi extension/,
  },
  {
    failure: "a startup dialog",
    source: startupDialog,
    error: /cannot accept a response-bearing extension UI request/i,
  },
])(
  "admits a restart once Pi retires after $failure",
  async ({ source, error }) => {
    const f = await fixture(source);
    await f.runtime.openSession(f.id);
    await vi.waitFor(
      () =>
        expect(f.event).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "runtime_error",
            sessionId: f.id,
            error: expect.stringMatching(error),
          }),
        ),
      { timeout: 10_000 },
    );
    const snapshot = await f.runtime.snapshot(f.id);
    expect(snapshot).toMatchObject({
      runState: "failed",
      pendingExtensionUiRequests: [],
    });
    expect(JSON.stringify([snapshot, f.event.mock.calls])).not.toContain(
      "private-native-token",
    );
    expect(f.workers).toHaveLength(1);
    expect(f.workers[0]?.pid).toBeNull();
    await commitIdleRestart(f.runtime);
  },
  20_000,
);

it("warns about malformed native settings and keeps them intact when an in-memory setter succeeds", async () => {
  const workspace = await nativePiWorkspace("inspire-startup-diagnostics-", {});
  cleanup.push(() => rm(workspace.root, { recursive: true, force: true }));
  const settingsPath = join(workspace.agent, "settings.json");
  const malformed = '{ "private-setting": ';
  await writeFile(settingsPath, malformed);
  const rpc = new PiRpcProcess({
    cwd: workspace.cwd,
    env: workspace.env,
    args: [
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-themes",
      "--no-tools",
    ],
  });
  cleanup.push(() => rpc.stop());
  const events: Record<string, unknown>[] = [];
  rpc.on("event", (event) => events.push(event));
  await rpc.start();
  expect(events.filter((event) => event.method === "notify")).toEqual([
    expect.objectContaining({
      notifyType: "warning",
      message: expect.stringContaining(settingsPath),
    }),
  ]);
  expect(JSON.stringify(events)).not.toContain("private-setting");
  await rpc.request({ type: "set_auto_compaction", enabled: false });
  expect(await rpc.request({ type: "get_state" })).toMatchObject({
    autoCompactionEnabled: false,
  });
  await rpc.stop();
  expect(await readFile(settingsPath, "utf8")).toBe(malformed);
}, 20_000);

it("bounds and deduplicates actionable startup diagnostics without disclosing stderr", () => {
  const settings = "C:\\Users\\fixture\\settings.json";
  const extensions = Array.from(
    { length: 20 },
    (_, index) =>
      `Error: Failed to load extension "/${"x".repeat(1000)}/${index}.ts": private-exception`,
  );
  const { failures, warnings } = piStartupDiagnostics(
    [
      "private unrelated output",
      `\x1b[31m${extensions[0]}\x1b[0m`,
      ...extensions.slice(1),
      `Warning: Invalid settings file ${settings}: private-settings-content`,
      `Warning: Invalid settings file ${settings}: duplicate`,
    ].join("\n"),
  );
  expect(failures).toHaveLength(3);
  expect(failures[0]).toContain("/0.ts");
  expect(failures.every((message) => message.length < 500)).toBe(true);
  expect(warnings).toEqual([expect.stringContaining(settings)]);
  expect(JSON.stringify({ failures, warnings })).not.toContain("private");
});
