// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppStore } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteHandler,
} from "./helpers";

const baseRoutes: RouteHandler = (url) => {
  if (url.startsWith("/api/bootstrap"))
    return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
  if (url.startsWith("/api/snapshot")) return { body: activeSnapshot() };
  if (url.startsWith("/api/sessions"))
    return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
  return undefined;
};

async function initStore(): Promise<{
  store: AppStore;
  socket: FakeWebSocket;
}> {
  const store = new AppStore();
  await store.init("token");
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return { store, socket };
}

const path = {
  id: "ZmlsZS50eHQ",
  display: "file.txt",
  utf8Path: "file.txt",
  workspacePath: "file.txt",
};
const cleanStatus = {
  kind: "repository" as const,
  head: { kind: "branch" as const, name: "main", oid: "0123456789abcdef" },
  files: [
    {
      path,
      staged: { kind: "modified" as const },
      unstaged: { kind: "modified" as const },
      untracked: false,
    },
  ],
  total: 1,
  truncated: false,
  groups: {
    conflicted: [],
    staged: [path.id],
    unstaged: [path.id],
    untracked: [],
  },
};

describe("Git inspection ownership and freshness", () => {
  beforeEach(() => installFakeWebSocket());

  it("retains the last good status visibly stale after a refresh failure", async () => {
    let failing = false;
    installFetch((url, init) => {
      if (url.startsWith("/api/git/status"))
        return failing
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

  it("preserves a selected diff when status polling retains the same facet", async () => {
    let diffCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/git/status")) return { body: cleanStatus };
      if (url.startsWith("/api/git/diff")) {
        diffCalls += 1;
        return {
          body: {
            kind: "text",
            path,
            side: "unstaged",
            truncated: false,
            encodingLossy: false,
            lines: [
              {
                kind: "add",
                text: `+version-${diffCalls}`,
                oldLine: null,
                newLine: 1,
              },
            ],
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.refreshGitStatus();
    await store.openGitDiff(path.id, "unstaged");
    expect(store.getState().gitDiff).toMatchObject({
      status: "ready",
      result: { lines: [{ text: "+version-1" }] },
    });

    await store.refreshGitStatus();
    expect(diffCalls).toBe(1);
    expect(store.getState().gitDiff).toMatchObject({
      status: "ready",
      result: { lines: [{ text: "+version-1" }] },
    });

    await store.refreshGitInspection();
    expect(diffCalls).toBe(2);
    expect(store.getState().gitDiff).toMatchObject({
      status: "ready",
      result: { lines: [{ text: "+version-2" }] },
    });
  });

  it("revalidates status and the open diff across a same-session transport replacement", async () => {
    let statusCalls = 0;
    let diffCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/git/status")) {
        statusCalls += 1;
        return {
          body: {
            ...cleanStatus,
            head: { ...cleanStatus.head, name: `branch-${statusCalls}` },
          },
        };
      }
      if (url.startsWith("/api/git/diff")) {
        diffCalls += 1;
        return {
          body: {
            kind: "text",
            path,
            side: "unstaged",
            truncated: false,
            encodingLossy: false,
            lines: [
              {
                kind: "add",
                text: `+transport-${diffCalls}`,
                oldLine: null,
                newLine: 1,
              },
            ],
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    store.setGitSurfaceVisible("resources-pane", true);
    await vi.waitFor(() =>
      expect(store.getState().gitStatus).toMatchObject({
        head: { name: "branch-1" },
      }),
    );
    await store.openGitDiff(path.id, "unstaged");
    expect(store.getState().gitDiff).toMatchObject({
      status: "ready",
      result: { lines: [{ text: "+transport-1" }] },
    });

    await store.init("replacement-token");
    await vi.waitFor(() =>
      expect(store.getState().gitDiff).toMatchObject({
        status: "ready",
        result: { lines: [{ text: "+transport-2" }] },
      }),
    );

    expect(statusCalls).toBe(2);
    expect(store.getState().gitStatus).toMatchObject({
      head: { name: "branch-2" },
    });
    store.setGitSurfaceVisible("resources-pane", false);
  });

  it("does not let an uncooperative old status request block replacement transport", async () => {
    let resolveOldStatus!: (response: { body: typeof cleanStatus }) => void;
    const oldStatus = new Promise<{ body: typeof cleanStatus }>((resolve) => {
      resolveOldStatus = resolve;
    });
    let statusCalls = 0;
    installFetch((url, init) => {
      if (url.startsWith("/api/git/status")) {
        statusCalls += 1;
        if (statusCalls === 1) return oldStatus;
        return {
          body: {
            ...cleanStatus,
            head: { ...cleanStatus.head, name: "replacement" },
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    store.setGitSurfaceVisible("resources-pane", true);
    await vi.waitFor(() => expect(statusCalls).toBe(1));

    await store.init("replacement-token");

    await vi.waitFor(() => {
      expect(statusCalls).toBe(2);
      expect(store.getState().gitStatus).toMatchObject({
        head: { name: "replacement" },
      });
    });
    resolveOldStatus({ body: cleanStatus });
    await Promise.resolve();
    expect(store.getState().gitStatus).toMatchObject({
      head: { name: "replacement" },
    });
    store.setGitSurfaceVisible("resources-pane", false);
  });

  it("does not reload the selected diff on the four-second status poll", async () => {
    vi.useFakeTimers();
    let store: AppStore | null = null;
    try {
      let diffCalls = 0;
      installFetch((url, init) => {
        if (url.startsWith("/api/git/status")) return { body: cleanStatus };
        if (url.startsWith("/api/git/diff")) {
          diffCalls += 1;
          return {
            body: {
              kind: "text",
              path,
              side: "unstaged",
              truncated: false,
              encodingLossy: false,
              lines: [],
            },
          };
        }
        return baseRoutes(url, init);
      });
      ({ store } = await initStore());
      await store.refreshGitStatus();
      store.setGitSurfaceVisible("resources-pane", true);
      await vi.advanceTimersByTimeAsync(0);
      await store.openGitDiff(path.id, "unstaged");
      const selectedDiff = store.getState().gitDiff;

      await vi.advanceTimersByTimeAsync(4_001);

      expect(diffCalls).toBe(1);
      expect(store.getState().gitDiff).toBe(selectedDiff);
    } finally {
      store?.setGitSurfaceVisible("resources-pane", false);
      vi.useRealTimers();
    }
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

  it("waits one full interval after a slow status completion before polling again", async () => {
    vi.useFakeTimers();
    let store: AppStore | null = null;
    try {
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
      ({ store } = await initStore());
      store.setGitSurfaceVisible("test", true);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(12_000);
      expect(calls).toBe(1);
      releases.shift()!();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(3_999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      releases.shift()!();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      store?.setGitSurfaceVisible("test", false);
      vi.useRealTimers();
    }
  });

  it("refreshes on a selected tool completion and stops the visible-only completion timer", async () => {
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
      socket.emit({
        type: "tool_execution_end",
        sessionId: "s1",
        toolCallId: "tool-1",
        toolName: "bash",
        result: "done",
      });
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
        init.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          body: { kind: "empty", path, side: "unstaged", reason: "no-changes" },
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    await store.refreshGitStatus();
    const opening = store.openGitDiff(path.id);
    await vi.waitFor(() => expect(requestedSide).toBe("unstaged"));
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ sessionId: "s2", cwd: "/other" }),
    });
    expect(aborted).toBe(true);
    release();
    await opening;
    expect(store.getState()).toMatchObject({
      sessionId: "s2",
      gitStatus: null,
      gitDiff: null,
      selectedGitPathId: null,
    });
  });
});
