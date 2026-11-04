// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectedWorkspacePath } from "../../src/components/WorkspaceBrowser";
import {
  activeSnapshot,
  deferred,
  installFakeWebSocket,
  installFetch,
  jsonBody,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

describe("selected file preview lifecycle", () => {
  beforeEach(() => {
    installFakeWebSocket();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chart");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  async function openImage() {
    let viewId = "view-s1";
    let resolveError = false;
    const requests: Record<string, unknown>[] = [];
    installFetch((url, init) => {
      if (url === "/api/prompt")
        return { body: { accepted: true, historyEntry: null } };
      if (url.startsWith("/api/resources/resolve")) {
        requests.push(jsonBody(init));
        if (resolveError)
          return { status: 403, body: { error: "File no longer authorized" } };
        return {
          body: {
            id: `chart-${requests.length}`,
            sessionId: "s1",
            viewId,
            reference: "plots/chart.png",
            workspacePath: "plots/chart.png",
            name: "chart.png",
            mimeType: "image/png",
            size: 5,
            kind: "image",
          },
        };
      }
      if (url.includes("/content"))
        return { body: "png", headers: { "Content-Type": "image/png" } };
      return baseRoutes(url, init);
    });
    const owner = await initStore();
    await owner.store.openResource("chart.png");
    expect(owner.store.getState().resourcePreview?.status).toBe("ready");
    return {
      ...owner,
      requests,
      setView: (value: string) => {
        viewId = value;
      },
      refuseResolve: () => {
        resolveError = true;
      },
    };
  }

  it("keeps the loaded image across prompt confirmation and ordinary appends", async () => {
    const { store, socket, requests } = await openImage();
    const preview = store.getState().resourcePreview;
    await expect(store.sendPrompt("Explain this result")).resolves.toEqual({
      accepted: true,
      historyEntry: null,
    });
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: { revision: 2 },
      }),
    });
    expect(store.getState().fileBrowserView).toBe("preview");
    expect(store.getState().resourcePreview).toBe(preview);
    expect(requests).toHaveLength(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not revive a closed loading tab after its late response (another file open: %s)",
    async (anotherFileOpen) => {
      const pending = deferred<void>();
      installFetch(async (url, init) => {
        if (url.startsWith("/api/resources/resolve")) {
          const { reference } = jsonBody(init);
          if (reference === "pending.txt") await pending.promise;
          return {
            body: {
              id: reference,
              sessionId: "s1",
              viewId: "view-s1",
              reference,
              name: reference,
              mimeType: "text/plain",
              size: 5,
              kind: "text",
            },
          };
        }
        if (url.includes("/content")) return { body: "Notes" };
        return baseRoutes(url, init);
      });
      const { store } = await initStore();
      const reading = store.openResource("pending.txt");
      expect(store.getState().resourceTabs).toEqual([
        { reference: "pending.txt" },
      ]);
      if (anotherFileOpen) await store.openResource("current.txt");
      store.closeResourceTab("pending.txt");
      pending.resolve();
      await reading;
      expect(store.getState().resourceTabs).toEqual(
        anotherFileOpen ? [{ reference: "current.txt" }] : [],
      );
      expect(store.getState().selectedResourceReference).toBe(
        anotherFileOpen ? "current.txt" : null,
      );
      expect(store.getState().fileBrowserView).toBe(
        anotherFileOpen ? "preview" : "browse",
      );
      expect(store.getState().resourcePreview?.reference ?? null).toBe(
        anotherFileOpen ? "current.txt" : null,
      );
    },
  );

  it.each([
    {
      label: "compaction view",
      viewId: "view-compacted",
      incarnation: "projection-1",
    },
    {
      label: "same-view rewrite",
      viewId: "view-s1",
      incarnation: "projection-1",
    },
    {
      label: "projection incarnation",
      viewId: "view-s1",
      incarnation: "projection-2",
    },
  ])(
    "reauthorizes the same file after a $label change without returning to Browse",
    async ({ viewId, incarnation }) => {
      const { store, socket, requests, setView } = await openImage();
      setView(viewId);
      socket.emit({
        type: "snapshot",
        data: activeSnapshot({
          transcriptPage: {
            revision: 2,
            appendFromRevision: 2,
            viewId,
            incarnation,
          },
        }),
      });
      expect(store.getState()).toMatchObject({
        fileBrowserView: "preview",
        selectedResourceReference: "chart.png",
        selectedResourceWorkspacePath: "plots/chart.png",
        resourcePreview: { status: "loading" },
      });
      expect(selectedWorkspacePath(store.getState())).toBe("plots/chart.png");
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:chart");
      await waitFor(() =>
        expect(store.getState().resourcePreview?.status).toBe("ready"),
      );
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({
        reference: "chart.png",
        workspacePath: "plots/chart.png",
      });
      expect(store.getState().resourcePreview).toMatchObject({
        descriptor: { id: "chart-2", viewId },
      });
      expect(store.getState().resourceTabs).toEqual([
        { reference: "chart.png", workspacePath: "plots/chart.png" },
      ]);
    },
  );

  it("keeps the file detail and reports failed reauthorization", async () => {
    const { store, socket, refuseResolve } = await openImage();
    refuseResolve();
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        transcriptPage: { revision: 2, appendFromRevision: 2 },
      }),
    });
    await waitFor(() =>
      expect(store.getState().resourcePreview).toMatchObject({
        status: "error",
        message: "File no longer authorized",
      }),
    );
    expect(store.getState().fileBrowserView).toBe("preview");
    expect(store.getState().selectedResourceReference).toBe("chart.png");
    expect(selectedWorkspacePath(store.getState())).toBe("plots/chart.png");
  });

  it("does not reopen a preview the user has left for Browse", async () => {
    const { store, socket, requests } = await openImage();
    store.showFileBrowser();
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({ transcriptPage: { viewId: "view-compacted" } }),
    });
    expect(store.getState().fileBrowserView).toBe("browse");
    expect(requests).toHaveLength(1);
  });

  it("keeps Files selected when closing its last viewed background tab", async () => {
    const { store } = await openImage();
    await store.openResource("other.png");
    store.showFileBrowser();
    store.closeResourceTab("other.png");
    expect(store.getState().resourceTabs).toEqual([
      { reference: "chart.png", workspacePath: "plots/chart.png" },
    ]);
    expect(store.getState().fileBrowserView).toBe("browse");
  });

  it("retires the selected file when the workspace changes", async () => {
    const { store, socket, requests } = await openImage();
    socket.emit({
      type: "snapshot",
      data: activeSnapshot({
        cwd: "/another-project",
        transcriptPage: { viewId: "view-other-project" },
      }),
    });
    expect(store.getState().fileBrowserView).toBe("browse");
    expect(store.getState().resourcePreview).toBeNull();
    expect(store.getState().resourceTabs).toEqual([]);
    expect(requests).toHaveLength(1);
  });
});
