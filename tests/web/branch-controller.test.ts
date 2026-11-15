import { describe, expect, it, vi } from "vitest";
import type {
  BranchForkResponse,
  BranchNavigateResponse,
} from "../../shared/contracts";
import { type Api, ApiError } from "../../src/api";
import { emptyTranscriptView } from "../../src/app-state";
import {
  BranchController,
  type BranchControllerPatch,
  type BranchControllerState,
} from "../../src/controllers/branch-controller";
import { activeSnapshot, deferred } from "./helpers";

function createHarness() {
  let state: BranchControllerState = {
    sessionId: "s1",
    view: {
      ...emptyTranscriptView,
      viewId: "view-1",
      incarnation: "incarnation-1",
      composerHistoryVersion: "history-1",
      effectiveLeafId: "a1",
      branchRevision: 1,
    },
    branchTreeError: null,
    branchActionId: null,
  };
  let selectionGeneration = 1;
  let selectionRequest = 1;
  const navigateBranch = vi.fn();
  const forkBranch = vi.fn();
  const cloneBranch = vi.fn();
  const sessionHistory = vi.fn();
  const branchImage = vi.fn();
  const deleteAttachment = vi.fn().mockResolvedValue(undefined);
  const commands = { navigateBranch, forkBranch, cloneBranch };
  let api = {
    json: (name: keyof typeof commands, { body }: { body: unknown }) =>
      commands[name](body),
    sessionHistory,
    branchImage,
    deleteAttachment,
  } as unknown as Api;
  const applyNavigation = vi.fn();
  const applyFork = vi.fn();
  const refreshSessionCatalog = vi.fn();
  const handleAuthFailure = vi.fn();
  const notify = vi.fn();
  const controller = new BranchController({
    state: () => state,
    patch: (patch: BranchControllerPatch) => {
      state = { ...state, ...patch };
    },
    api: () => api,
    selectionGeneration: () => selectionGeneration,
    selectionRequest: () => selectionRequest,
    beginForkSelection: () => ++selectionRequest,
    draftRevision: () => 0,
    handleAuthFailure,
    applyNavigation,
    applyFork,
    refreshSessionCatalog,
    notify,
  });
  return {
    controller,
    state: () => state,
    patch: ({
      view,
      ...patch
    }: Partial<Omit<BranchControllerState, "view">> & {
      view?: Partial<BranchControllerState["view"]>;
    }) => {
      state = {
        ...state,
        ...patch,
        ...(view ? { view: { ...state.view, ...view } } : {}),
      };
    },
    invalidateSelection: () => {
      selectionGeneration += 1;
      selectionRequest += 1;
      controller.invalidate();
    },
    replaceTransport: () => {
      api = { ...api };
      controller.invalidate();
    },
    navigateBranch,
    forkBranch,
    cloneBranch,
    sessionHistory,
    branchImage,
    deleteAttachment,
    applyNavigation,
    applyFork,
    refreshSessionCatalog,
    handleAuthFailure,
    notify,
  };
}

describe("BranchController", () => {
  it.each(["entry", "image"] as const)(
    "keeps immutable %s reads through same-view append, but rejects replaced owners",
    async (kind) => {
      const read = (harness: ReturnType<typeof createHarness>) =>
        kind === "entry"
          ? harness.controller.history("s1", "view-1", {
              kind: "entry",
              targetId: "retained-point",
              offset: 0,
            })
          : harness.controller.readImage("retained-point", 1);
      const endpoint = kind === "entry" ? "sessionHistory" : "branchImage";
      const result =
        kind === "entry" ? { text: "Retained content" } : new Blob(["image"]);
      const harness = createHarness();
      const pending = deferred<typeof result>();
      harness[endpoint].mockReturnValue(pending.promise);
      const reading = read(harness);
      expect(harness[endpoint]).toHaveBeenCalledOnce();
      harness.patch({
        view: { effectiveLeafId: "appended" },
      });
      pending.resolve(result);
      await expect(reading).resolves.toBe(result);

      for (const replacement of ["session", "view", "transport"] as const) {
        const replaced = createHarness();
        const stale = deferred<typeof result>();
        replaced[endpoint].mockReturnValue(stale.promise);
        const staleRead = read(replaced);
        if (replacement === "session") replaced.invalidateSelection();
        else if (replacement === "view")
          replaced.patch({ view: { viewId: "replaced-view" } });
        else replaced.replaceTransport();
        if (kind === "entry")
          stale.reject(new ApiError(401, "Previous selection credentials"));
        else stale.resolve(result);
        await expect(staleRead).resolves.toBeNull();
        expect(replaced.handleAuthFailure).not.toHaveBeenCalled();
      }
    },
  );

  it("reports current History authorization failure", async () => {
    const f = createHarness();
    f.sessionHistory.mockRejectedValue(new ApiError(401, "Expired"));
    await expect(
      f.controller.history("s1", "view-1", {
        kind: "entry",
        targetId: "point",
        offset: 0,
      }),
    ).resolves.toBeNull();
    expect(f.handleAuthFailure).toHaveBeenCalledOnce();
  });

  it.each(["append", "view replacement"] as const)(
    "retires navigation after %s",
    async (change) => {
      const harness = createHarness();
      const pending = deferred<BranchNavigateResponse>();
      harness.navigateBranch.mockReturnValue(pending.promise);
      const navigation = harness.controller.navigate("a1", "switch");
      harness.patch({
        view:
          change === "append"
            ? { effectiveLeafId: "appended" }
            : { viewId: "replacement" },
      });
      pending.reject(new ApiError(409, "Source changed"));
      await expect(navigation).resolves.toBe(false);
      expect(harness.applyNavigation).not.toHaveBeenCalled();
      expect(harness.state()).toMatchObject({
        branchActionId: null,
        branchTreeError: null,
      });
    },
  );

  it.each(["fork", "clone"] as const)(
    "uses the captured %s prefix despite a later append",
    async (action) => {
      const h = createHarness();
      const response = deferred<BranchForkResponse>();
      const command = action === "fork" ? h.forkBranch : h.cloneBranch;
      command.mockReturnValue(response.promise);
      const copying =
        action === "fork" ? h.controller.fork("u1") : h.controller.clone();
      h.patch({ view: { effectiveLeafId: "a2" } });
      const snapshot = {
        sessionId: "forked",
        snapshot: activeSnapshot({ sessionId: "forked" }),
        editorText: "",
      };
      response.resolve(snapshot);
      await expect(copying).resolves.toBe(true);
      expect(command).toHaveBeenCalledExactlyOnceWith({
        sessionId: "s1",
        viewId: "view-1",
        targetId: action === "fork" ? "u1" : "a1",
      });
      expect(h.applyFork).toHaveBeenCalledExactlyOnceWith(snapshot);
      if (action !== "fork") return;
      command.mockRejectedValueOnce(new ApiError(409, "Source changed"));
      await expect(h.controller.fork("u1")).resolves.toBe(false);
      expect(h.state()).toMatchObject({
        branchActionId: null,
        branchTreeError: "Source changed",
      });
      const retired = deferred<BranchForkResponse>();
      command.mockReturnValue(retired.promise);
      const pending = h.controller.fork("u1");
      h.replaceTransport();
      retired.reject(new ApiError(401, "Previous transport credentials"));
      await expect(pending).resolves.toBe(false);
      expect(h.handleAuthFailure).not.toHaveBeenCalled();
    },
  );

  it("applies the returned editor text when the socket publishes this same navigation first", async () => {
    const harness = createHarness();
    const pending = deferred<BranchNavigateResponse>();
    harness.navigateBranch.mockReturnValue(pending.promise);
    const navigation = harness.controller.navigate("a1", "edit");
    harness.controller.retireReads();
    harness.patch({
      view: { viewId: "navigated", effectiveLeafId: "u1" },
    });
    const response = {
      snapshot: activeSnapshot({
        transcriptPage: { viewId: "navigated" },
        effectiveLeafId: "u1",
      }),
      editorText: "returned draft",
    };
    pending.resolve(response);
    expect(await navigation).toBe(true);
    expect(harness.applyNavigation).toHaveBeenCalledWith(response, 0);
    expect(harness.state().branchActionId).toBeNull();
  });

  it.each(["clone", "fork"] as const)(
    "retires a successful %s even after reselecting its source",
    async (action) => {
      const f = createHarness();
      const response = deferred<BranchForkResponse>();
      (action === "clone" ? f.cloneBranch : f.forkBranch).mockReturnValue(
        response.promise,
      );
      const copying =
        action === "clone" ? f.controller.clone() : f.controller.fork("u1");
      for (const sessionId of ["s2", "s1"]) {
        f.invalidateSelection();
        f.patch({ sessionId });
      }
      response.resolve({
        sessionId: "forked",
        snapshot: activeSnapshot({ sessionId: "forked" }),
        editorText: "",
        editorAttachments:
          action === "fork"
            ? [
                {
                  id: "discarded-image",
                  fileName: "image.png",
                  mimeType: "image/png",
                  size: 1,
                  kind: "image",
                },
              ]
            : [],
      });
      expect(await copying).toBe(false);
      if (action === "fork")
        expect(f.deleteAttachment).toHaveBeenCalledExactlyOnceWith(
          "discarded-image",
        );
      expect(f.applyFork).not.toHaveBeenCalled();
    },
  );
});
