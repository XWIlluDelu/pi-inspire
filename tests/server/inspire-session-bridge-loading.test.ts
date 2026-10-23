import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  discoverAndLoadExtensions,
  type ExtensionContext,
  type SessionShutdownEvent,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import {
  type PiActivityRecord,
  piActivityDirectory,
} from "../../extensions/inspire-session-bridge.js";

it("shares one reporter across both installed paths while preserving reload and independent SDK sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "inspire-bridge-loading-"));
  const legacy = resolve("docs/examples/session-activity.ts");
  const current = resolve("extensions/inspire-session-bridge.ts");
  type Loaded = Awaited<ReturnType<typeof discoverAndLoadExtensions>>;
  const instances: Array<{ loaded: Loaded; context: ExtensionContext }> = [];
  const context = (id: string) =>
    ({
      mode: "rpc",
      cwd: root,
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => id,
        getSessionFile: () => join(root, `${id}.jsonl`),
      },
    }) as unknown as ExtensionContext;
  const emit = async (
    instance: (typeof instances)[number],
    event: SessionStartEvent | SessionShutdownEvent,
  ) => {
    for (const extension of instance.loaded.extensions)
      for (const handler of extension.handlers.get(event.type) ?? [])
        await handler(event, instance.context);
  };
  const load = async (paths: string[], owner: ExtensionContext) => {
    const loaded = await discoverAndLoadExtensions(
      paths,
      root,
      join(root, "agent"),
    );
    expect(loaded.errors).toEqual([]);
    const instance = { loaded, context: owner };
    instances.push(instance);
    return instance;
  };
  const records = async () => {
    const directory = piActivityDirectory();
    const names = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    const values: PiActivityRecord[] = await Promise.all(
      names.map(async (name) =>
        JSON.parse(await readFile(join(directory, name), "utf8")),
      ),
    );
    return values;
  };
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("LOCALAPPDATA", join(root, "local"));
  vi.stubEnv("INSPIRE_BRANCH_COMMAND", "");
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const first = await load([legacy, current], context("first"));
    await emit(first, { type: "session_start", reason: "startup" });
    expect(vi.getTimerCount()).toBe(1);
    expect(await records()).toMatchObject([{ sessionId: "first" }]);

    const second = await load([current, legacy], context("second"));
    await emit(second, { type: "session_start", reason: "startup" });
    expect(vi.getTimerCount()).toBe(2);
    expect((await records()).map((record) => record.sessionId).sort()).toEqual([
      "first",
      "second",
    ]);

    await emit(first, { type: "session_shutdown", reason: "reload" });
    expect(vi.getTimerCount()).toBe(1);
    const reloaded = await load([current, legacy], first.context);
    await emit(reloaded, { type: "session_start", reason: "reload" });
    expect(vi.getTimerCount()).toBe(2);
    expect(await records()).toHaveLength(2);

    // Late cleanup from the old entry points cannot retire the new owner.
    await emit(first, { type: "session_shutdown", reason: "quit" });
    expect(vi.getTimerCount()).toBe(2);
    await emit(reloaded, { type: "session_shutdown", reason: "quit" });
    expect(vi.getTimerCount()).toBe(1);
    expect(
      (await records()).filter((record) => !record.inactive),
    ).toMatchObject([{ sessionId: "second" }]);
  } finally {
    for (const instance of instances)
      await emit(instance, { type: "session_shutdown", reason: "quit" });
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
