// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countBusySessions } from "../../shared/session-activity";
import { type AppState, createInitialAppState } from "../../src/app-state";
import { SessionRow } from "../../src/components/NavSessions";
import { RuntimeEventController } from "../../src/controllers/runtime-event-controller";
import { useAppState } from "../../src/store";
import { sessionSummary } from "./helpers";

// This is the observational UI boundary, independent of browser authentication.
vi.mock("../../src/store", () => ({
  store: {},
  useAppState: vi.fn(),
  shallowEqual: Object.is,
}));

const external = sessionSummary({
  id: "external",
  title: "External Pi",
  cwd: "/work",
});
let state: AppState;
let events: RuntimeEventController;
const ensureSessionVisible = vi.fn();

beforeEach(() => {
  state = createInitialAppState();
  ensureSessionVisible.mockClear();
  vi.mocked(useAppState).mockImplementation((select) => select(state));
  events = new RuntimeEventController({
    state: () => state,
    patch: (patch: Partial<AppState>) => {
      state = { ...state, ...patch };
    },
    ensureSessionVisible,
    notify: vi.fn(),
    openSession: vi.fn(async () => {}),
    applySnapshot: vi.fn(),
    invalidateSelection: vi.fn(),
    recordRuntimeReady: vi.fn(),
    clearRuntimeReady: vi.fn(),
    refreshLoadedSessions: vi.fn(async () => {}),
    hasVisibleGitSurface: () => false,
    refreshGitStatus: vi.fn(async () => {}),
    markProjectionStale: vi.fn(),
    selectionGeneration: () => 0,
    resync: vi.fn(async () => {}),
  });
});

function row() {
  return (
    <SessionRow session={external} selectedSessionId="s1" onSelect={() => {}} />
  );
}

describe("session activity presentation", () => {
  it("uses one dot-matrix family for work and unread terminal outcomes", () => {
    state.sessionStatuses = {
      external: { runState: "running", indicator: "running" },
    };
    const view = render(row());
    expect(
      screen.getByRole("img", { name: "Working" }).querySelector(".pi-loading"),
    ).toBeTruthy();
    for (const [indicator, label] of [
      ["completed", "Completed"],
      ["failed", "Failed"],
    ] as const) {
      state.sessionStatuses = {
        external: {
          runState: indicator === "completed" ? "idle" : "failed",
          indicator,
        },
      };
      view.rerender(row());
      const mark = screen.getByRole("img", { name: label });
      expect(mark.querySelector(".pi-status")).toHaveAttribute(
        "data-status",
        indicator === "completed" ? "success" : "error",
      );
      expect(mark.querySelector(".pi-loading")).toBeNull();
      view.rerender(
        <SessionRow
          session={external}
          selectedSessionId="external"
          onSelect={() => {}}
        />,
      );
      expect(screen.queryByRole("img", { name: label })).toBeNull();
    }
    state.sessionStatuses = {
      external: { runState: "conflict", indicator: "attention" },
    };
    view.rerender(row());
    const attention = screen.getByRole("img", { name: "Needs recovery" });
    expect(attention.querySelector(".pi-loading,.pi-status")).toBeNull();
  });

  it("keeps managed input-blocked work static without enabling deletion", () => {
    state.sessionStatuses = {
      external: { runState: "running", indicator: "running", needsInput: true },
    };
    const view = render(row());
    expect(screen.getByRole("img", { name: "Waiting for input" })).toHaveClass(
      "nav__row-dot--attention",
    );
    expect(view.container.querySelector(".pi-loading")).toBeNull();
  });

  it("counts all busy identities once, excluding idle and input-blocked sessions", () => {
    expect(
      countBusySessions(
        {
          one: { runState: "running" },
          two: { runState: "retrying" },
          compact: { runState: "compacting" },
          queued: { runState: "queued" },
          waiting: { runState: "running", needsInput: true },
          idle: { runState: "idle" },
        },
        {
          one: "working",
          external: "working",
          blocked: "blocked",
          resting: "idle",
        },
      ),
    ).toBe(5);
  });

  it("requests catalog hydration and shows work/input/idle without adopting runtime authority", () => {
    events.apply({
      type: "external_session_activity",
      activities: { external: "working" },
    });
    const view = render(row());
    expect(screen.getByRole("img", { name: "Working in Pi" })).toBeTruthy();
    expect(ensureSessionVisible).toHaveBeenCalledWith("external");
    expect(state.sessionStatuses.external).toBeUndefined();
    expect(state.completedRunSequence).toBe(0);

    events.apply({
      type: "external_session_activity",
      activities: { external: "blocked" },
    });
    view.rerender(row());
    expect(
      screen.getByRole("img", { name: "Waiting for input in Pi" }),
    ).toBeTruthy();
    expect(countBusySessions({}, state.externalSessionActivities)).toBe(0);

    events.apply({
      type: "external_session_activity",
      activities: { external: "idle" },
    });
    view.rerender(row());
    expect(screen.queryByRole("img", { name: /in Pi/ })).toBeNull();
    expect(screen.getByTitle(/Idle in Pi/)).toBeTruthy();
  });

  it("replaces complete observations and rejects malformed maps without altering managed work", () => {
    state.sessionStatuses = { managed: { runState: "running" } };
    events.apply({
      type: "external_session_activity",
      activities: { external: "working" },
    });
    events.apply({
      type: "external_session_activity",
      activities: { external: "invalid" },
    });
    expect(state.externalSessionActivities).toEqual({ external: "working" });
    events.apply({ type: "external_session_activity", activities: {} });
    expect(state.externalSessionActivities).toEqual({});
    expect(state.sessionStatuses).toEqual({ managed: { runState: "running" } });
  });

  it("does not hide a managed recovery indicator behind an external work observation", () => {
    state.sessionStatuses = {
      external: { runState: "conflict", indicator: "attention" },
    };
    events.apply({
      type: "external_session_activity",
      activities: { external: "working" },
    });
    render(row());
    expect(screen.getByRole("img", { name: "Needs recovery" })).toBeTruthy();
  });
});
