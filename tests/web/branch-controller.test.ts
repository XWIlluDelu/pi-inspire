import { afterEach, describe, expect, it, vi } from "vitest";
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

function createHarness(initial: Partial<BranchControllerState> = {}) {
  let state: BranchControllerState = {
    sessionId: "s1",
    view: {
      ...emptyTranscriptView,
      viewId: "view-1",
      incarnation: "incarnation-1",
      composerHistoryVersion: "history-1",
      durableLeafId: "a1",
      effectiveLeafId: "a1",
      branchRevision: 1,
    },
    branchTreeError: null,
    branchActionId: null,
    ...initial,
  };
  let selectionGeneration = 1;
  let selectionRequest = 1;
  const navigateBranch = vi.fn();
  const forkBranch = vi.fn();
  const cloneBranch = vi.fn();
  const sessionHistory = vi.fn();
  const branchImage = vi.fn();
  let api = {
    navigateBranch,
    forkBranch,
    cloneBranch,
    sessionHistory,
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
    applyNavigation,
    applyFork,
    refreshSessionCatalog,
    handleAuthFailure,
    notify,
  };
}

describe("BranchController", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    { branchActionId: "another-action" },
    {
      view: {
        ...emptyTranscriptView,
        health: { status: "error" as const, message: "Unreadable source" },
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
      const endpoint = kind === "entry" ? "sessionHistory" : "branchImage";
      const result =
        kind === "entry" ? { text: "Retained content" } : new Blob(["image"]);
      const harness = createHarness();
      const pending = deferred<typeof result>();
      harness[endpoint].mockReturnValue(pending.promise);
      const reading = read(harness);
      if (kind === "entry")
        expect(harness.sessionHistory).toHaveBeenCalledWith(
          "s1",
          "view-1",
          {
            kind: "entry",
            targetId: "retained-point",
            offset: 0,
          },
          expect.any(AbortSignal),
        );
      else
        expect(harness.branchImage.mock.calls[0]?.[0]).toMatchObject({
          sessionId: "s1",
          viewId: "view-1",
          targetId: "retained-point",
        });
      harness.patch({
        view: { effectiveLeafId: "appended", durableLeafId: "appended" },
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

  it.each(["caller", "selection", "transport"] as const)(
    "settles a paused inspection without another request after %s cancellation",
    async (change) => {
      vi.useFakeTimers();
      const harness = createHarness();
      harness.sessionHistory.mockRejectedValue(
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
      expect(harness.sessionHistory).toHaveBeenCalledOnce();
    },
  );

  it("bounds persistent inspection recovery and keeps authorization failures definitive", async () => {
    vi.useFakeTimers();
    for (const status of [503, 403, 401]) {
      const harness = createHarness();
      harness.sessionHistory.mockRejectedValue(
        new ApiError(status, "Read failed"),
      );
      const reading = harness.controller.readEntry("point");
      const outcome =
        status === 401
          ? expect(reading).resolves.toBeNull()
          : expect(reading).rejects.toMatchObject({ status });
      await vi.advanceTimersByTimeAsync(14_000);
      await outcome;
      expect(harness.sessionHistory).toHaveBeenCalledTimes(
        status === 503 ? 4 : 1,
      );
      expect(harness.handleAuthFailure).toHaveBeenCalledTimes(
        status === 401 ? 1 : 0,
      );
    }
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

  it("discards complete-content Copy if its view changes while reading the image", async () => {
    const h = createHarness();
    const image = deferred<Blob>();
    h.sessionHistory.mockResolvedValue({
      text: "saved input",
      nextOffset: null,
      images: [{ index: 0, mimeType: "image/png" }],
    });
    h.branchImage.mockReturnValue(image.promise);
    const copying = h.controller.copyContent(
      "u1",
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(h.branchImage).toHaveBeenCalledOnce());
    h.patch({ view: { viewId: "next" } });
    image.resolve(new Blob(["saved pixels"]));
    await expect(copying).resolves.toBeNull();
  });

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

  it("does not apply a successful Clone after returning to the same session", async () => {
    const harness = createHarness();
    const response = deferred<BranchForkResponse>();
    harness.cloneBranch.mockReturnValue(response.promise);
    const cloning = harness.controller.clone();
    harness.invalidateSelection();
    harness.patch({ sessionId: "s2" });
    harness.invalidateSelection();
    harness.patch({ sessionId: "s1" });
    response.resolve({} as BranchForkResponse);
    expect(await cloning).toBe(false);
    expect(harness.cloneBranch).toHaveBeenCalledOnce();
    expect(harness.applyFork).not.toHaveBeenCalled();
  });
});
