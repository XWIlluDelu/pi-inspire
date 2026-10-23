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
  branchCopiesBlocked,
} from "../../src/controllers/branch-controller";
import { deferred, branchTree as tree } from "./helpers";

function createHarness(initial: Partial<BranchControllerState> = {}) {
  let state: BranchControllerState = {
    sessionId: "s1",
    transcriptViewId: "view-1",
    transcriptDurableLeafId: "a1",
    transcriptEffectiveLeafId: "a1",
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
    transportGeneration: () => transportGeneration,
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
    notify,
  };
}

describe("BranchController", () => {
  afterEach(() => vi.useRealTimers());

  it("renews stale History after reconnecting without a manual refresh or replayed action", async () => {
    const harness = createHarness({ connection: "reconnecting" });
    harness.branchTree.mockResolvedValue({ ...tree(), effectiveLeafId: "a1" });
    harness.controller.markConnectionInterrupted();
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

  it("recovers an append-raced History read under its new position without an error", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const pending = deferred<BranchTreeResponse>();
    harness.branchTree.mockReturnValueOnce(pending.promise);
    const reading = harness.controller.loadTree();
    harness.patch({
      transcriptEffectiveLeafId: "next",
      transcriptDurableLeafId: "next",
    });
    pending.resolve({ ...tree(), effectiveLeafId: "a1" });
    await reading;
    expect(harness.state()).toMatchObject({
      branchTreeError: null,
      branchTreeStale: true,
      branchTreeLoading: false,
    });
    harness.branchTree.mockResolvedValue({
      ...tree(),
      effectiveLeafId: "next",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.state()).toMatchObject({
      branchTreeStale: false,
      branchTreeLoading: false,
      branchTreeError: null,
    });
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
  ])(
    "shares unavailable clone state with menu entry points: %j",
    async (initial) => {
      const harness = createHarness(initial);
      expect(branchCopiesBlocked(harness.state())).toBe(true);
      expect(await harness.controller.clone()).toBe(false);
      expect(harness.cloneBranch).not.toHaveBeenCalled();
      harness.patch({
        branchTreeError: null,
        branchTreeLoading: false,
        branchActionId: null,
        projectionHealth: { status: "ok" },
        readOnlyReason: null,
      });
      expect(branchActionsBlocked(harness.state())).toBe(false);
    },
  );

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

  it.each(["tree", "entry", "image"] as const)(
    "recovers a transient %s inspection without repeating an action",
    async (kind) => {
      vi.useFakeTimers();
      const harness = createHarness();
      const endpoint =
        kind === "tree"
          ? "branchTree"
          : kind === "entry"
            ? "branchEntry"
            : "branchImage";
      const result =
        kind === "tree"
          ? tree()
          : kind === "entry"
            ? { text: "Retained content" }
            : new Blob(["image"]);
      harness[endpoint]
        .mockRejectedValueOnce(new ApiError(503, "Temporary read failure"))
        .mockResolvedValue(result);
      const signal = new AbortController();
      const reading =
        kind === "tree"
          ? harness.controller.readTree({ query: "Root" }, signal.signal)
          : kind === "entry"
            ? harness.controller.readEntry("point", 0, signal.signal)
            : harness.controller.readImage("point", 0, signal.signal);
      void reading.catch(() => {});
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(reading).resolves.toBe(result);
      expect(harness[endpoint]).toHaveBeenCalledTimes(2);
      expect(harness.navigateBranch).not.toHaveBeenCalled();
      expect(harness.forkBranch).not.toHaveBeenCalled();
      expect(harness.cloneBranch).not.toHaveBeenCalled();
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
      viewId: "view-1",
      targetId: "a1",
    });
    expect(harness.navigateBranch).not.toHaveBeenCalled();
    expect(harness.applyFork).toHaveBeenCalledTimes(1);
  });
  it.each(["fork", "clone", "latest"] as const)(
    "does not revive a pending %s gesture after returning to the same session",
    async (action) => {
      const currentTree = { ...tree(), effectiveLeafId: "u1" };
      const harness = createHarness({
        transcriptEffectiveLeafId: "u1",
        branchTree: currentTree,
      });
      const oldTree = deferred<BranchTreeResponse>();
      harness.branchTree.mockResolvedValue(currentTree);
      if (action === "latest")
        harness.branchTree.mockReturnValueOnce(oldTree.promise);
      const copyResponse = deferred<BranchForkResponse>();
      harness.forkBranch.mockReturnValue(copyResponse.promise);
      harness.cloneBranch.mockReturnValue(copyResponse.promise);
      harness.navigateBranch.mockResolvedValue({} as BranchNavigateResponse);
      const pending =
        action === "fork"
          ? harness.controller.forkFromEntry("u1")
          : action === "clone"
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
      expect(harness.forkBranch).toHaveBeenCalledTimes(
        action === "fork" ? 1 : 0,
      );
      expect(harness.cloneBranch).toHaveBeenCalledTimes(
        action === "clone" ? 1 : 0,
      );
      expect(harness.navigateBranch).not.toHaveBeenCalled();
      expect(harness.applyFork).not.toHaveBeenCalled();
    },
  );

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
      const copying =
        mode === "fork"
          ? harness.controller.forkFromEntry("u1")
          : harness.controller.clone("u1");
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
      const staleCopy =
        mode === "fork"
          ? replaced.controller.forkFromEntry("u1")
          : replaced.controller.clone("u1");
      await vi.waitFor(() =>
        expect(replaced.state().branchActionId).toBe(`${mode}:u1`),
      );
      replaced.invalidateSelection();
      stale.resolve({} as BranchForkResponse);
      await expect(staleCopy).resolves.toBe(false);
      expect(replaced.applyFork).not.toHaveBeenCalled();
      expect(replaced.notify).not.toHaveBeenCalled();
    },
  );
});
