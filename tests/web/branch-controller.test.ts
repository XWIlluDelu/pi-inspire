import { describe, expect, it, vi } from "vitest";
import type {
  BranchForkResponse,
  BranchNavigateResponse,
  BranchTreeResponse,
} from "../../shared/contracts";
import { ApiError, type Api } from "../../src/api";
import {
  BranchController,
  type BranchControllerPatch,
  type BranchControllerState,
} from "../../src/controllers/branch-controller";

function tree(): BranchTreeResponse {
  return {
    sessionId: "s1",
    revision: 1,
    incarnation: "tree-1",
    durableLeafId: "a1",
    effectiveLeafId: null,
    activePath: ["u1", "a1"],
    truncated: false,
    health: { status: "ok" },
    nodes: [
      {
        id: "u1",
        parentId: null,
        depth: 0,
        type: "message",
        role: "user",
        label: "user",
        snippet: "user",
        timestamp: "2026-08-01",
        active: true,
        leaf: false,
        canSwitch: false,
        canEdit: false,
        canFork: true,
      },
      {
        id: "a1",
        parentId: "u1",
        depth: 1,
        type: "message",
        role: "assistant",
        label: "assistant",
        snippet: "answer",
        timestamp: "2026-08-01",
        active: true,
        leaf: true,
        canSwitch: true,
        canEdit: false,
        canFork: false,
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

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
  const api = { branchTree, navigateBranch, forkBranch } as unknown as Api;
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
    applyNavigation,
    applyFork,
    refreshSessionCatalog,
    handleAuthFailure,
  };
}

describe("BranchController", () => {
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

  it("commits a verified fork through the facade and refreshes the catalog", async () => {
    const harness = createHarness();
    harness.forkBranch.mockResolvedValue({} as BranchForkResponse);

    await expect(harness.controller.fork("u1")).resolves.toBe(true);

    expect(harness.applyFork).toHaveBeenCalledTimes(1);
    expect(harness.refreshSessionCatalog).toHaveBeenCalledTimes(1);
  });
});
