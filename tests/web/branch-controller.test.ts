import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BranchForkResponse,
  BranchNavigateResponse,
  BranchTreeResponse,
} from "../../shared/contracts";
import { type Api, ApiError } from "../../src/api";
import {
  BranchController,
  type BranchControllerPatch,
  type BranchControllerState,
  branchActionsBlocked,
} from "../../src/controllers/branch-controller";
import { deferred, branchTree as tree } from "./helpers";

function createHarness(initial: Partial<BranchControllerState> = {}) {
  let state: BranchControllerState = {
    sessionId: "s1",
    transcriptViewId: "view-1",
    transcriptDurableLeafId: "a1",
    transcriptEffectiveLeafId: "a1",
    transcriptNavigationLeased: false,
    branchTree: tree(),
    branchTreeLoading: false,
    branchTreeError: null,
    branchActionId: null,
    projectionHealth: { status: "ok" },
    projectionConflict: null,
    ...initial,
  };
  let selectionGeneration = 1;
  let selectionRequest = 1;
  const branchTree = vi.fn();
  const navigateBranch = vi.fn();
  const forkBranch = vi.fn();
  const cloneBranch = vi.fn();
  const branchEntry = vi.fn();
  const branchImage = vi.fn();
  let api = {
    branchTree,
    navigateBranch,
    forkBranch,
    cloneBranch,
    branchEntry,
    branchImage,
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
    patch: (patch: Partial<BranchControllerState>) => {
      state = { ...state, ...patch };
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
    branchTree,
    navigateBranch,
    forkBranch,
    cloneBranch,
    branchEntry,
    branchImage,
    applyNavigation,
    applyFork,
    refreshSessionCatalog,
    handleAuthFailure,
    notify,
  };
}

describe("BranchController", () => {
  afterEach(() => vi.useRealTimers());

  it("renews stale History after reconnecting without a manual refresh or replayed action", async () => {
    const harness = createHarness({ connection: "reconnecting" });
    harness.branchTree.mockResolvedValue({ ...tree(), effectiveLeafId: "a1" });
    harness.controller.invalidate();
    expect(harness.state()).toMatchObject({
      branchTreeStale: true,
      branchTreeError: null,
    });
    expect(branchActionsBlocked(harness.state())).toBe(true);
    harness.controller.reconcile();
    expect(harness.branchTree).not.toHaveBeenCalled();
    harness.patch({ connection: "open" });
    harness.controller.reconcile();
    await vi.waitFor(() => expect(harness.state().branchTreeStale).toBe(false));
    expect(branchActionsBlocked(harness.state())).toBe(false);
    expect(harness.branchTree).toHaveBeenCalledOnce();
    expect(harness.navigateBranch).not.toHaveBeenCalled();
  });

  it.each([
    { branchActionId: "another-action" },
    {
      projectionHealth: {
        status: "error" as const,
        message: "Unreadable source",
      },
    },
    { readOnlyReason: "workspace-unavailable" as const },
  ])("rejects Clone while its source cannot be copied: %j", async (initial) => {
    const harness = createHarness(initial);
    expect(await harness.controller.clone()).toBe(false);
    expect(harness.cloneBranch).not.toHaveBeenCalled();
  });

  it.each(["entry", "image"] as const)(
    "keeps immutable %s reads through same-view append, but rejects replaced owners",
    async (kind) => {
      const read = (harness: ReturnType<typeof createHarness>) =>
        kind === "entry"
          ? harness.controller.readEntry("retained-point")
          : harness.controller.readImage("retained-point", 1);
      const endpoint = kind === "entry" ? "branchEntry" : "branchImage";
      const result =
        kind === "entry" ? { text: "Retained content" } : new Blob(["image"]);
      const harness = createHarness();
      const pending = deferred<typeof result>();
      harness[endpoint].mockReturnValue(pending.promise);
      const reading = read(harness);
      expect(harness[endpoint].mock.calls[0]?.[0]).toMatchObject({
        sessionId: "s1",
        viewId: "view-1",
        targetId: "retained-point",
      });
      harness.patch({
        transcriptEffectiveLeafId: "appended",
        transcriptDurableLeafId: "appended",
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
          replaced.patch({ transcriptViewId: "replaced-view" });
        else replaced.replaceTransport();
        if (replacement === "session" && kind === "entry")
          stale.reject(new Error("Previous selection read failed"));
        else stale.resolve(result);
        await expect(staleRead).resolves.toBeNull();
      }
    },
  );

  it.each(["caller", "selection", "transport"] as const)(
    "settles a paused inspection without another request after %s cancellation",
    async (change) => {
      vi.useFakeTimers();
      const harness = createHarness();
      harness.branchEntry.mockRejectedValue(
        new ApiError(503, "Temporary read failure"),
      );
      const caller = new AbortController();
      const reading = harness.controller.readEntry("point", 0, caller.signal);
      void reading.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      if (change === "caller") caller.abort();
      else if (change === "selection") harness.invalidateSelection();
      else harness.replaceTransport();
      await expect(reading).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.branchEntry).toHaveBeenCalledOnce();
    },
  );

  it("bounds persistent inspection recovery and keeps authorization failures definitive", async () => {
    vi.useFakeTimers();
    for (const status of [503, 403, 401]) {
      const harness = createHarness();
      harness.branchEntry.mockRejectedValue(
        new ApiError(status, "Read failed"),
      );
      const reading = harness.controller.readEntry("point");
      const outcome =
        status === 401
          ? expect(reading).resolves.toBeNull()
          : expect(reading).rejects.toMatchObject({ status });
      await vi.advanceTimersByTimeAsync(14_000);
      await outcome;
      expect(harness.branchEntry).toHaveBeenCalledTimes(status === 503 ? 4 : 1);
      expect(harness.handleAuthFailure).toHaveBeenCalledTimes(
        status === 401 ? 1 : 0,
      );
    }
  });

  it("retains position fencing for navigation during same-view append", async () => {
    const harness = createHarness();
    const pending = deferred<BranchNavigateResponse>();
    harness.navigateBranch.mockReturnValue(pending.promise);
    const navigation = harness.controller.navigate("a1", "switch");
    harness.patch({ transcriptEffectiveLeafId: "appended" });
    pending.resolve({} as BranchNavigateResponse);
    await expect(navigation).resolves.toBe(false);
    expect(harness.applyNavigation).not.toHaveBeenCalled();
    expect(harness.state().branchActionId).toBeNull();
  });

  it.each(["clone", "latest"] as const)(
    "does not revive a pending %s gesture after returning to the same session",
    async (action) => {
      const currentTree = { ...tree(), effectiveLeafId: "u1" };
      const harness = createHarness({
        transcriptEffectiveLeafId: "u1",
        transcriptNavigationLeased: true,
        branchTree: currentTree,
      });
      const oldTree = deferred<BranchTreeResponse>();
      harness.branchTree.mockResolvedValue(currentTree);
      if (action === "latest")
        harness.branchTree.mockReturnValueOnce(oldTree.promise);
      const copyResponse = deferred<BranchForkResponse>();
      harness.cloneBranch.mockReturnValue(copyResponse.promise);
      harness.navigateBranch.mockResolvedValue({} as BranchNavigateResponse);
      const pending =
        action === "clone"
          ? harness.controller.clone()
          : harness.controller.returnToLatest();

      // A -> B -> A leaves the same file/leaf visible, but owns a new visit.
      harness.invalidateSelection();
      harness.patch({ sessionId: "s2" });
      harness.invalidateSelection();
      harness.patch({ sessionId: "s1" });
      await harness.controller.loadTree();
      oldTree.resolve(currentTree);
      copyResponse.resolve({} as BranchForkResponse);
      expect(await pending).toBe(false);
      expect(harness.cloneBranch).toHaveBeenCalledTimes(
        action === "clone" ? 1 : 0,
      );
      expect(harness.navigateBranch).not.toHaveBeenCalled();
      expect(harness.applyFork).not.toHaveBeenCalled();
    },
  );
});
