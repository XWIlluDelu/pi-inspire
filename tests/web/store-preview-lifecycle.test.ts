// @vitest-environment jsdom

import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectedWorkspacePath } from "../../src/components/WorkspaceBrowser";
import { inspectedPreview } from "../../src/resource-preview";
import { fakeResourceDescriptor } from "./fixtures/resources";
import {
  activeSnapshot,
  deferred,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  selectSession,
} from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

const chart = { reference: "chart.png", workspacePath: "plots/chart.png" };
const embedded = "pi-embedded://0/0";

async function fixture() {
  let viewId = "view-s1";
  let refused = false;
  const requests: Record<string, unknown>[] = [];
  const pending = deferred<void>();
  installFetch(async (url, init) => {
    if (url === "/api/prompt")
      return { body: { accepted: true, historyEntry: null } };
    if (url === "/api/resources/resolve") {
      const query = jsonBody(init);
      requests.push(query);
      const reference = String(query.reference);
      if (reference === "pending.png") await pending.promise;
      if (refused)
        return { status: 403, body: { error: "File no longer authorized" } };
      const workspacePath =
        reference === embedded ? undefined : `plots/${reference}`;
      return {
        body: fakeResourceDescriptor(workspacePath ?? reference, {
          id: `${reference}-${requests.length}`,
          viewId,
          workspacePath,
          mimeType: "image/png",
          kind: "image",
        }),
      };
    }
    if (url.includes("/content"))
      return { body: "png", headers: { "Content-Type": "image/png" } };
    return baseRoutes(url, init);
  });
  const { store, socket } = await initStore();
  return {
    store,
    requests,
    pending,
    state: () => store.getState(),
    preview: () => inspectedPreview(store.getState().fileInspection),
    update: (overrides: Parameters<typeof activeSnapshot>[0]) => {
      const snapshot = activeSnapshot(overrides);
      viewId = snapshot.active!.transcriptPage.viewId;
      socket.emitSnapshot(snapshot);
    },
    refuseResolve: () => {
      refused = true;
    },
  };
}

describe("selected file preview lifecycle", () => {
  beforeEach(() => {
    installFakeWebSocket();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chart");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("does not revive a closed loading tab or displace its replacement", async () => {
    const { store, state, pending } = await fixture();
    const read = store.openResource("pending.png");
    expect(state().resourceTabs).toEqual([{ reference: "pending.png" }]);
    store.closeResourceTab("pending.png");
    expect(state().fileInspection).toEqual({ kind: "browse" });
    await store.openResource(chart.reference);
    pending.resolve();
    await read;
    expect(state()).toMatchObject({
      resourceTabs: [chart],
      fileInspection: { kind: "file", ...chart, preview: { status: "ready" } },
    });
  });

  it("keeps a preview through an append and reauthorizes it on a replaced view", async () => {
    const { store, state, preview, requests, update, refuseResolve } =
      await fixture();
    await store.openResource(chart.reference);
    const first = preview();
    expect(first?.status).toBe("ready");
    await expect(
      store.sendPrompt("Explain this result"),
    ).resolves.toMatchObject({
      accepted: true,
    });
    update({ transcriptPage: { revision: 2 } });
    expect(preview()).toBe(first);
    expect(requests).toHaveLength(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    const viewId = "view-compacted";
    for (const transcriptPage of [
      { revision: 3, viewId },
      { revision: 4, viewId, appendFromRevision: 4 },
      { revision: 4, viewId, incarnation: "projection-2" },
    ]) {
      const revokedBefore = vi.mocked(URL.revokeObjectURL).mock.calls.length;
      update({ transcriptPage });
      expect(preview()?.status).toBe("loading");
      expect(selectedWorkspacePath(state())).toBe(chart.workspacePath);
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(revokedBefore + 1);
      await waitFor(() => expect(preview()?.status).toBe("ready"));
      expect(requests.at(-1)).toMatchObject(chart);
      expect(preview()).toMatchObject({ descriptor: { viewId } });
      expect(state().resourceTabs).toEqual([chart]);
    }
    expect(requests).toHaveLength(4);

    refuseResolve();
    update({
      transcriptPage: {
        revision: 5,
        viewId,
        incarnation: "projection-2",
        appendFromRevision: 5,
      },
    });
    await waitFor(() =>
      expect(preview()).toMatchObject({
        status: "error",
        message: "File no longer authorized",
      }),
    );
    expect(state().fileInspection).toMatchObject({ kind: "file", ...chart });
  });

  it("retires positional tabs on rewrite or branch switch and keeps the named Files view", async () => {
    const { store, state, preview, requests, update } = await fixture();
    await store.openResource(chart.reference);
    for (const transcriptPage of [
      { revision: 2, appendFromRevision: 2 },
      { viewId: "view-branch-b" },
    ]) {
      await store.openResource(embedded);
      expect(preview()).toMatchObject({ status: "ready", reference: embedded });
      update({ transcriptPage });
      expect(state()).toMatchObject({
        fileInspection: { kind: "browse" },
        resourceTabs: [chart],
      });
    }
    await store.openResource("other.png");
    expect(state().resourceTabs).toHaveLength(2);
    store.showFileBrowser();
    update({ transcriptPage: { viewId: "view-branch-c" } });
    store.closeResourceTab("other.png");
    expect(state()).toMatchObject({
      fileInspection: { kind: "browse" },
      resourceTabs: [chart],
    });
    expect(requests).toHaveLength(4);
  });

  it("discards the selected file and URL across workspace and session changes", async () => {
    const { store, state, preview, requests, update } = await fixture();
    const assertRetired = () =>
      expect(state()).toMatchObject({
        fileInspection: { kind: "browse" },
        resourceTabs: [],
      });
    await store.openResource(chart.reference);
    update({
      cwd: "/another-project",
      transcriptPage: { viewId: "view-other-project" },
    });
    assertRetired();
    await store.openResource(chart.reference);
    expect(preview()?.status).toBe("ready");
    await selectSession(
      store,
      activeSnapshot({ sessionId: "s2", cwd: "/another-project" }),
    );
    assertRetired();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
  });
});
