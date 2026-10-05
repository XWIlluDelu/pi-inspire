import { describe, expect, it, vi } from "vitest";
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
} from "../../src/controllers/branch-controller";
import { deferred, branchTree as tree } from "./helpers";

function createHarness(initial: Partial<BranchControllerState> = {}) {
  let state: BranchControllerState = {
    sessionId: "s1",
    transcriptViewId: "view-1",
    transcriptDurableLeafId: "a1",
    transcriptEffectiveLeafId: null,
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
  let transportGeneration = 1;
  const branchTree = vi.fn();
  const navigateBranch = vi.fn();
  const forkBranch = vi.fn();
  const cloneBranch = vi.fn();
  const branchEntry = vi.fn();
  const branchImage = vi.fn();
  const api = {
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
  const controller = new BranchController({
    state: () => state,
    patch: (patch: BranchControllerPatch) => {
      state = { ...state, ...patch };
    },
    api: () => api,
    selectionGeneration: () => selectionGeneration,
    selectionRequest: () => selectionRequest,
    beginForkSelection: () => ++selectionRequest,
    transportGeneration: () => transportGeneration,
    draftRevision: () => 0,
    handleAuthFailure,
    applyNavigation,
    applyFork,
    refreshSessionCatalog,
    notify: vi.fn(),
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
      controller.invalidateForSelectionIntent();
    },
    replaceTransport: () => {
      transportGeneration += 1;
      controller.invalidateForTransportReplacement();
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
  };
}

describe("BranchController", () => {
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
        stale.resolve(result);
        await expect(staleRead).resolves.toBeNull();
      }
    },
  );

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

  it("discards a read-only preview error after its view owner changes", async () => {
    const pending = deferred<never>();
    const harness = createHarness();
    harness.branchEntry.mockReturnValue(pending.promise);
    const reading = harness.controller.readEntry("retained-old-point");
    harness.invalidateSelection();
    pending.reject(new Error("obsolete preview error"));
    await expect(reading).resolves.toBeNull();
    expect(harness.state().branchTreeError).not.toBe("obsolete preview error");
  });

  it("keeps native cancellation separate from successful navigation and errors", async () => {
    const harness = createHarness();
    harness.navigateBranch.mockResolvedValue({
      cancelled: true,
    } as BranchNavigateResponse);
    await expect(
      harness.controller.navigate("a1", "switch", { summarize: true }),
    ).resolves.toBe(false);
    expect(harness.applyNavigation).not.toHaveBeenCalled();
    expect(harness.state()).toMatchObject({
      branchActionId: null,
      branchTreeError: null,
    });
  });

  it("clones the current endpoint without requiring an editable or loaded user node", async () => {
    const harness = createHarness();
    harness.branchTree.mockResolvedValue(tree());
    harness.cloneBranch.mockResolvedValue({} as BranchForkResponse);
    await expect(harness.controller.clone()).resolves.toBe(true);
    expect(harness.cloneBranch).toHaveBeenCalledWith({
      sessionId: "s1",
      revision: tree().revision,
    });
    expect(harness.navigateBranch).not.toHaveBeenCalled();
    expect(harness.applyFork).toHaveBeenCalledTimes(1);
  });
  it("does not publish a tree that lost selection ownership", async () => {
    const pending = deferred<BranchTreeResponse>();
    const harness = createHarness({ branchTree: null });
    harness.branchTree.mockReturnValue(pending.promise);

    const loading = harness.controller.loadTree();
    harness.invalidateSelection();
    pending.resolve(tree());
    await loading;

    expect(harness.state()).toMatchObject({
      branchTree: null,
      branchTreeLoading: false,
      branchTreeError: null,
    });
  });

  it("keeps a replaced transport from applying a stale navigation response", async () => {
    const harness = createHarness();
    const response = deferred<BranchNavigateResponse>();
    harness.navigateBranch.mockReturnValue(response.promise);

    const navigation = harness.controller.navigate("a1", "switch");
    harness.replaceTransport();
    response.resolve({} as BranchNavigateResponse);
    await expect(navigation).resolves.toBe(false);

    expect(harness.applyNavigation).not.toHaveBeenCalled();
    expect(harness.state().branchActionId).toBeNull();
  });

  it("routes a current branch authorization failure through the host", async () => {
    const harness = createHarness({ branchTree: null });
    harness.branchTree.mockRejectedValue(new ApiError(401, "unauthorized"));

    await harness.controller.loadTree();

    expect(harness.handleAuthFailure).toHaveBeenCalledTimes(1);
  });

  it("revalidates the current earlier branch before returning to latest", async () => {
    const currentTree: BranchTreeResponse = {
      ...tree(),
      effectiveLeafId: "u1",
      activePath: ["u1"],
    };
    const harness = createHarness({
      transcriptEffectiveLeafId: "u1",
      branchTree: currentTree,
    });
    harness.branchTree.mockResolvedValue(currentTree);
    harness.navigateBranch.mockResolvedValue({} as BranchNavigateResponse);

    await expect(harness.controller.returnToLatest()).resolves.toBe(true);

    expect(harness.navigateBranch).toHaveBeenCalledWith({
      sessionId: "s1",
      revision: currentTree.revision,
      targetId: "a1",
      mode: "switch",
    });
    expect(harness.applyNavigation).toHaveBeenCalledTimes(1);
  });

  it.each(["fork", "clone"] as const)(
    "opens a committed %s despite source append progress, but never a replaced selection",
    async (mode) => {
      const harness = createHarness();
      const response = deferred<BranchForkResponse>();
      harness.branchTree.mockResolvedValue(tree());
      harness[mode === "fork" ? "forkBranch" : "cloneBranch"].mockReturnValue(
        response.promise,
      );
      const copying = harness.controller[mode]("u1");
      await vi.waitFor(() =>
        expect(harness.state().branchActionId).toBe(`${mode}:u1`),
      );
      harness.patch({
        transcriptDurableLeafId: "new-assistant",
        transcriptEffectiveLeafId: "new-assistant",
      });
      response.resolve({} as BranchForkResponse);
      await expect(copying).resolves.toBe(true);
      expect(harness.applyFork).toHaveBeenCalledTimes(1);
      expect(harness.refreshSessionCatalog).toHaveBeenCalledTimes(1);
      expect(harness.state().branchActionId).toBeNull();

      const replaced = createHarness();
      const stale = deferred<BranchForkResponse>();
      replaced.branchTree.mockResolvedValue(tree());
      replaced[mode === "fork" ? "forkBranch" : "cloneBranch"].mockReturnValue(
        stale.promise,
      );
      const staleCopy = replaced.controller[mode]("u1");
      await vi.waitFor(() =>
        expect(replaced.state().branchActionId).toBe(`${mode}:u1`),
      );
      replaced.invalidateSelection();
      stale.resolve({} as BranchForkResponse);
      await expect(staleCopy).resolves.toBe(false);
      expect(replaced.applyFork).not.toHaveBeenCalled();
    },
  );
});
