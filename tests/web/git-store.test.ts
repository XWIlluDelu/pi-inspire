// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppStore } from "../../src/store";
import { activeSnapshot, bootstrapPayload, FakeWebSocket, installFakeWebSocket, installFetch, jsonBody, type RouteHandler } from "./helpers";

const baseRoutes: RouteHandler = (url) => {
  if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
  if (url.startsWith("/api/snapshot")) return { body: activeSnapshot() };
  if (url.startsWith("/api/sessions")) return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
  return undefined;
};

async function initStore(): Promise<{ store: AppStore; socket: FakeWebSocket }> {
  const store = new AppStore();
  await store.init("token");
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return { store, socket };
}

const path = { id: "ZmlsZS50eHQ", display: "file.txt", utf8Path: "file.txt", workspacePath: "file.txt" };
const cleanStatus = {
  kind: "repository" as const,
  head: { kind: "branch" as const, name: "main", oid: "0123456789abcdef" },
  files: [{ path, staged: { kind: "modified" as const }, unstaged: { kind: "modified" as const }, untracked: false }],
  total: 1,
  truncated: false,
  groups: { conflicted: [], staged: [path.id], unstaged: [path.id], untracked: [] },
};

describe("Git inspection ownership and freshness", () => {
  beforeEach(() => installFakeWebSocket());

  it("retains the last good status visibly stale after a refresh failure", async () => {
    let failing = false;
    installFetch((url, init) => {
      if (url.startsWith("/api/git/status")) return failing
        ? { status: 503, body: { error: "Git timed out" } }
        : { body: cleanStatus };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.refreshGitStatus();
    expect(store.getState().gitStatus).toEqual(cleanStatus);
    failing = true;
    await store.refreshGitStatus();
    expect(store.getState().gitStatus).toEqual(cleanStatus);
    expect(store.getState().gitStatusError).toBe("Git timed out");
  });

  it("re-fetches a selected diff when status succeeds with the same facet identity", async () => {
    let diffCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/git/status")) return { body: cleanStatus };
      if (url.startsWith("/api/git/diff")) {
        diffCalls += 1;
        return { body: {
          kind: "text", path, side: "unstaged", truncated: false, encodingLossy: false,
          lines: [{ kind: "add", text: `+version-${diffCalls}`, oldLine: null, newLine: 1 }],
        } };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.refreshGitStatus();
    await store.openGitDiff(path.id, "unstaged");
    expect(store.getState().gitDiff).toMatchObject({ status: "ready", result: { lines: [{ text: "+version-1" }] } });

    await store.refreshGitStatus();
    await vi.waitFor(() => expect(store.getState().gitDiff)
      .toMatchObject({ status: "ready", result: { lines: [{ text: "+version-2" }] } }));
    expect(diffCalls).toBe(2);
  });

  it("coalesces in-flight hints into exactly one queued rerun", async () => {
    const releases: Array<() => void> = [];
    let calls = 0;
    installFetch(async (url, init) => {
      if (url.startsWith("/api/git/status")) {
        calls += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        return { body: cleanStatus };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    store.setGitSurfaceVisible("test", true);
    await vi.waitFor(() => expect(calls).toBe(1));
    const queued = store.refreshGitStatus();
    void store.refreshGitStatus();
    releases.shift()!();
    await vi.waitFor(() => expect(calls).toBe(2));
    releases.shift()!();
    await queued;
    expect(calls).toBe(2);
    store.setGitSurfaceVisible("test", false);
  });

  it("refreshes on a selected tool completion and stops the visible-only interval", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      installFetch((url, init) => {
        if (url.startsWith("/api/git/status")) {
          calls += 1;
          return { body: cleanStatus };
        }
        return baseRoutes(url, init);
      });
      const { store, socket } = await initStore();
      store.setGitSurfaceVisible("test", true);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      socket.emit({ type: "tool_execution_end", sessionId: "s1", toolCallId: "tool-1", toolName: "bash", result: "done" });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(calls).toBe(3);
      store.setGitSurfaceVisible("test", false);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults a multifacet path to unstaged and drops a late diff after a session switch", async () => {
    let release!: () => void;
    let requestedSide = "";
    let aborted = false;
    installFetch(async (url, init) => {
      if (url.startsWith("/api/git/status")) return { body: cleanStatus };
      if (url.startsWith("/api/git/diff")) {
        requestedSide = String(jsonBody(init).side);
        init.signal?.addEventListener("abort", () => { aborted = true; });
        await new Promise<void>((resolve) => { release = resolve; });
        return { body: { kind: "empty", path, side: "unstaged", reason: "no-changes" } };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    await store.refreshGitStatus();
    const opening = store.openGitDiff(path.id);
    await vi.waitFor(() => expect(requestedSide).toBe("unstaged"));
    socket.emit({ type: "snapshot", data: activeSnapshot({ sessionId: "s2", cwd: "/other" }) });
    expect(aborted).toBe(true);
    release();
    await opening;
    expect(store.getState()).toMatchObject({ sessionId: "s2", gitStatus: null, gitDiff: null, selectedGitPathId: null });
  });
});
