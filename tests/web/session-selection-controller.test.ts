import { describe, expect, it, vi } from "vitest";
import type { ActiveSnapshot } from "../../shared/contracts";
import type { Api } from "../../src/api";
import {
  SessionSelectionController,
  type SessionSelectionState,
} from "../../src/controllers/session-selection-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function snapshot(sessionId: string | null): ActiveSnapshot {
  return {
    active: sessionId ? ({ sessionId } as ActiveSnapshot["active"]) : null,
    sessionStatuses: {},
    runState: "idle",
  } as ActiveSnapshot;
}

function createHarness(initial: Partial<SessionSelectionState> = {}) {
  let state: SessionSelectionState = {
    sessionId: "visible",
    cwd: "/workspace",
    openingSessionId: null,
    ...initial,
  };
  let selectionRequest = 0;
  let openingOwner: number | null = null;
  let transportGeneration = 1;
  let currentApi: Api;
  const openSession = vi.fn();
  const deselectSession = vi.fn();
  const newSession = vi.fn();
  currentApi = { openSession, deselectSession, newSession } as unknown as Api;
  const applySnapshot = vi.fn();
  const ensureSessionVisible = vi.fn();
  const setActionError = vi.fn();
  const rememberModel = vi.fn();
  const refreshSessionCatalog = vi.fn();
  const notify = vi.fn();
  const controller = new SessionSelectionController({
    state: () => state,
    api: () => currentApi,
    transportGeneration: () => transportGeneration,
    beginOpening: (sessionId) => {
      const ticket = ++selectionRequest;
      openingOwner = ticket;
      state = { ...state, openingSessionId: sessionId };
      return ticket;
    },
    invalidateOpening: () => {
      selectionRequest += 1;
      openingOwner = null;
      state = { ...state, openingSessionId: null };
    },
    ownsOpening: (ticket, api, generation) =>
      ticket === selectionRequest &&
      openingOwner === ticket &&
      currentApi === api &&
      transportGeneration === generation,
    releaseOpening: (ticket) => {
      if (openingOwner !== ticket) return;
      openingOwner = null;
      state = { ...state, openingSessionId: null };
    },
    applySnapshot,
    ensureSessionVisible,
    consumeReadyWhileOpening: () => false,
    resyncSelected: vi.fn(),
    setActionError,
    rememberModel,
    refreshSessionCatalog,
    notify,
    handleAuthFailure: vi.fn(),
  });
  return {
    controller,
    state: () => state,
    openSession,
    deselectSession,
    newSession,
    applySnapshot,
    ensureSessionVisible,
    setActionError,
    rememberModel,
    refreshSessionCatalog,
    notify,
    replaceTransport: () => {
      transportGeneration += 1;
      currentApi = {
        openSession: vi.fn(),
        deselectSession: vi.fn(),
        newSession: vi.fn(),
      } as unknown as Api;
    },
  };
}

describe("SessionSelectionController", () => {
  it("commits only the newest open intent", async () => {
    const first = deferred<ActiveSnapshot>();
    const second = deferred<ActiveSnapshot>();
    const harness = createHarness();
    harness.openSession.mockImplementation((id: string) =>
      id === "first" ? first.promise : second.promise,
    );

    const firstOpen = harness.controller.open("first");
    const secondOpen = harness.controller.open("second");
    second.resolve(snapshot("second"));
    await secondOpen;
    first.resolve(snapshot("first"));
    await firstOpen;

    expect(harness.applySnapshot).toHaveBeenCalledTimes(1);
    expect(harness.applySnapshot).toHaveBeenCalledWith(snapshot("second"));
    expect(harness.ensureSessionVisible).toHaveBeenCalledWith("second");
    expect(harness.state().openingSessionId).toBeNull();
  });

  it("clears an in-flight owner when bootstrap supersedes it", async () => {
    const pending = deferred<ActiveSnapshot>();
    const harness = createHarness();
    harness.openSession.mockReturnValue(pending.promise);

    const opening = harness.controller.open("pending");
    harness.controller.invalidateForReplacement();
    expect(harness.state().openingSessionId).toBeNull();
    pending.resolve(snapshot("pending"));
    await opening;

    expect(harness.applySnapshot).not.toHaveBeenCalled();
  });

  it("does not let an old transport create a session after bootstrap replacement", async () => {
    const pending = deferred<ActiveSnapshot>();
    const harness = createHarness();
    harness.newSession.mockReturnValue(pending.promise);

    const creating = harness.controller.create("/workspace");
    harness.replaceTransport();
    pending.resolve(snapshot("new-session"));

    await expect(creating).resolves.toBeNull();
    expect(harness.applySnapshot).not.toHaveBeenCalled();
  });

  it("keeps the missing-workspace refusal local and does not begin a request", async () => {
    const harness = createHarness({ cwd: null });

    await expect(harness.controller.create()).resolves.toBeNull();

    expect(harness.notify).toHaveBeenCalledWith(
      "warning",
      "Enter a project directory to start a session",
    );
    expect(harness.newSession).not.toHaveBeenCalled();
  });
});
