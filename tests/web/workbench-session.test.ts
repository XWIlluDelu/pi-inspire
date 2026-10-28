import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppStore } from "../../src/store";
import {
  lastWorkbenchSession,
  readNavCollapsed,
  saveNavCollapsed,
} from "../../src/workbench-session";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  TEST_HOST_AUTHORITY,
} from "./helpers";

describe("browser workbench restoration", () => {
  let authorityId: string;
  let cwd: string;
  let missing: string | null;
  let bootstrapDetails: Array<string | null>;
  let resolved: string[];
  let bootstrapWait: Promise<void> | null;
  let missingSession: string | null;

  beforeEach(() => {
    installFakeWebSocket();
    authorityId = TEST_HOST_AUTHORITY;
    cwd = "/demo";
    missing = null;
    bootstrapDetails = [];
    resolved = [];
    bootstrapWait = null;
    missingSession = null;
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        const query = new URL(url, "http://localhost").searchParams;
        const detail = query.get("detail");
        bootstrapDetails.push(detail);
        if (bootstrapWait) await bootstrapWait;
        if (detail && detail === missingSession)
          return {
            status: 404,
            body: { error: "Session not found", code: "SESSION_NOT_FOUND" },
          };
        return {
          body: bootstrapPayload({
            authorityId,
            snapshot:
              detail === ""
                ? { active: null, runState: "idle", sessionStatuses: {} }
                : activeSnapshot({ sessionId: detail ?? "s1", cwd }),
          }),
        };
      }
      if (url === "/api/sessions/open")
        return {
          body: activeSnapshot({ sessionId: String(jsonBody(init).id), cwd }),
        };
      if (url === "/api/sessions/deselect")
        return {
          body: { active: null, runState: "idle", sessionStatuses: {} },
        };
      if (url.startsWith("/api/resources/resolve")) {
        const { sessionId, reference } = jsonBody(init);
        resolved.push(String(reference));
        if (reference === missing)
          return { status: 404, body: { error: "File was deleted" } };
        return {
          body: {
            id: `fresh-${resolved.length}`,
            sessionId,
            viewId: `view-${sessionId}`,
            reference,
            workspacePath: reference,
            name: reference,
            mimeType: "text/plain",
            size: 20,
            kind: "text",
          },
        };
      }
      if (url.includes("/content")) return { body: "PRIVATE FILE BODY" };
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      return undefined;
    });
  });

  async function reload() {
    const store = new AppStore();
    await store.init("token");
    FakeWebSocket.instances.at(-1)!.open(undefined, authorityId);
    return store;
  }

  it("restores ordered tabs, the selected file and independent reading metadata with fresh authorization", async () => {
    const first = await reload();
    await first.openResource("readme.md");
    await first.openResource("other.txt");
    const reading = first.fileReadingState("readme.md");
    reading.source.current = { top: 480, left: 24 };
    reading.rendered.current = { top: 900, left: 0 };
    reading.mode = "source";
    reading.save?.();
    saveNavCollapsed(true);
    const second = await reload();
    await waitFor(() =>
      expect(second.getState().resourcePreview?.status).toBe("ready"),
    );
    expect(bootstrapDetails).toEqual([null, "s1"]);
    expect(second.getState()).toMatchObject({
      resourcesOpen: true,
      contextMode: "files",
      fileBrowserView: "preview",
      selectedResourceReference: "other.txt",
      resourceTabs: [
        { reference: "readme.md", workspacePath: "readme.md" },
        { reference: "other.txt", workspacePath: "other.txt" },
      ],
    });
    expect(resolved).toEqual(["readme.md", "other.txt", "other.txt"]);
    expect(second.fileReadingState("readme.md")).toMatchObject({
      source: { current: { top: 480, left: 24 } },
      rendered: { current: { top: 900, left: 0 } },
      mode: "source",
    });
    expect(second.fileReadingState("other.txt").source.current).toBeNull();
    expect(readNavCollapsed()).toBe(true);
    expect(JSON.stringify(sessionStorage)).not.toContain("PRIVATE FILE BODY");
    expect(JSON.stringify(sessionStorage)).not.toContain("fresh-");
    second.closeResourceTab("readme.md");
    expect(second.fileReadingState("readme.md").source.current).toBeNull();
  });

  it("restores a tool tab without loading file content or issuing a terminal command", async () => {
    const first = await reload();
    await first.openResource("readme.md");
    first.setContextMode("terminal");
    const second = await reload();
    expect(second.getState()).toMatchObject({
      resourcesOpen: true,
      contextMode: "terminal",
      resourceTabs: [{ reference: "readme.md" }],
      resourcePreview: null,
    });
    expect(resolved).toEqual(["readme.md"]);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url).includes("/terminal")),
    ).toBe(false);
  });

  it("keeps a missing active file as a tab with its read error", async () => {
    const first = await reload();
    await first.openResource("deleted.txt");
    missing = "deleted.txt";
    const second = await reload();
    await waitFor(() =>
      expect(second.getState().resourcePreview?.status).toBe("error"),
    );
    expect(second.getState()).toMatchObject({
      fileBrowserView: "preview",
      resourceTabs: [{ reference: "deleted.txt" }],
      resourcePreview: { status: "error", message: "File was deleted" },
    });
  });

  it("partitions tabs and reading positions by session and restores the exact last session", async () => {
    const first = await reload();
    await first.openResource("one.txt");
    const position = first.fileReadingState("one.txt");
    position.source.current = { top: 240, left: 0 };
    position.save?.();
    await first.openSession("s2");
    expect(first.getState().resourceTabs).toEqual([]);
    expect(first.fileReadingState("one.txt").source.current).toBeNull();
    await first.openResource("two.txt");
    const second = await reload();
    expect(second.getState().sessionId).toBe("s2");
    expect(second.getState().resourceTabs).toEqual([
      { reference: "two.txt", workspacePath: "two.txt" },
    ]);
    await second.openSession("s1");
    expect(second.getState().resourceTabs).toEqual([
      { reference: "one.txt", workspacePath: "one.txt" },
    ]);
    expect(second.fileReadingState("one.txt").source.current).toEqual({
      top: 240,
      left: 0,
    });
  });

  it("does not apply a different workspace's saved file metadata", async () => {
    const first = await reload();
    await first.openResource("one.txt");
    cwd = "/another-project";
    const differentCwd = await reload();
    expect(differentCwd.getState().resourceTabs).toEqual([]);
  });

  it("reauthorizes saved filenames after the same origin's Host restarts", async () => {
    const first = await reload();
    await first.openResource("one.txt");
    authorityId = "22222222-2222-4222-8222-222222222222";
    const restarted = await reload();
    await waitFor(() =>
      expect(restarted.getState().resourcePreview?.status).toBe("ready"),
    );
    expect(restarted.getState().resourceTabs).toEqual([
      { reference: "one.txt", workspacePath: "one.txt" },
    ]);
    expect(resolved).toEqual(["one.txt", "one.txt"]);
    expect(bootstrapDetails).toEqual([null, "s1"]);
  });

  it("keeps a closed context pane closed with its file tabs available", async () => {
    const first = await reload();
    await first.openResource("one.txt");
    first.setResourcesOpen(false);
    const second = await reload();
    expect(second.getState()).toMatchObject({
      resourcesOpen: false,
      resourceTabs: [{ reference: "one.txt" }],
      resourcePreview: null,
    });
    expect(second.getState()).toMatchObject({
      selectedResourceReference: "one.txt",
      fileBrowserView: "preview",
    });
    expect(resolved).toEqual(["one.txt"]);
    second.setResourcesOpen(true);
    await waitFor(() =>
      expect(second.getState().resourcePreview?.status).toBe("ready"),
    );
    expect(resolved).toEqual(["one.txt", "one.txt"]);
  });

  it("keeps a newer file choice made while a reconnect bootstrap is pending", async () => {
    const store = await reload();
    await store.openResource("old.txt");
    const pending = deferred<void>();
    bootstrapWait = pending.promise;
    const reconnect = store.init("token");
    await waitFor(() => expect(bootstrapDetails).toHaveLength(2));
    await store.openResource("new.txt");
    pending.resolve();
    await reconnect;
    await waitFor(() =>
      expect(store.getState().resourcePreview?.status).toBe("ready"),
    );
    expect(store.getState().selectedResourceReference).toBe("new.txt");
  });

  it("recovers a missing remembered session to an empty read-only bootstrap", async () => {
    const first = await reload();
    await first.openResource("one.txt");
    missingSession = "s1";
    const second = await reload();
    expect(bootstrapDetails).toEqual([null, "s1", ""]);
    expect(second.getState()).toMatchObject({
      bootstrapped: true,
      sessionId: null,
      connectionProblem: null,
    });
    expect(second.getState().notices.at(-1)?.text).toContain(
      "previous session no longer exists",
    );
  });

  it("does not let refused storage interrupt navigation", async () => {
    vi.spyOn(
      Object.getPrototypeOf(window.sessionStorage),
      "setItem",
    ).mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    const store = await reload();
    await store.openResource("one.txt");
    expect(store.getState().resourcePreview?.status).toBe("ready");
    expect(lastWorkbenchSession()).toBeNull();
  });
});
