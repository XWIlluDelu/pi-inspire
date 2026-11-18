// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countBusySessions } from "../../shared/session-activity";
import { type AppState, createInitialAppState } from "../../src/app-state";
import { HiddenClearDialog } from "../../src/components/HiddenClearDialog";
import { SessionRow } from "../../src/components/NavSessions";
import { SessionDeleteDialog } from "../../src/components/SessionDeleteDialog";
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
    applySnapshot: vi.fn(),
    applyTranscript: () => {},
    refreshLoadedSessions: vi.fn(async () => {}),
    hasVisibleGitSurface: () => false,
    refreshGitStatus: vi.fn(async () => {}),
    selectionGeneration: () => 0,
    invalidateResync: vi.fn(),
    resync: vi.fn(async () => {}),
  });
});

function row() {
  return (
    <SessionRow session={external} selectedSessionId="s1" onSelect={() => {}} />
  );
}

describe("session activity presentation", () => {
  it("acknowledges only the viewed outcome and shows the next result in that session", () => {
    const completed = {
      runState: "idle",
      indicator: "completed",
      attentionId: 17,
    } as const;
    expect(
      events.projectSessionStatuses({ external: completed }, "other").external
        ?.indicator,
    ).toBe("completed");
    expect(
      events.projectSessionStatuses({ external: completed }, "external")
        .external?.indicator,
    ).toBeUndefined();
    expect(
      events.projectSessionStatuses({ external: completed }, "other").external
        ?.indicator,
    ).toBeUndefined();
    events.apply({
      type: "session_status",
      sessionId: "external",
      sessionStatus: { ...completed, attentionId: 18 },
    });
    expect(state.sessionStatuses.external).toMatchObject({
      indicator: "completed",
      attentionId: 18,
    });
  });

  it("warns before deleting an externally owned session regardless of its observation source", () => {
    state.prefs.hiddenSessionIds = [external.id];
    events.apply({
      type: "external_session_activity",
      activities: { [external.id]: "working" },
    });
    const single = () => (
      <SessionDeleteDialog session={external} onClose={() => {}} />
    );
    const bulk = (id: string) => (
      <HiddenClearDialog sessionIds={[id]} onClose={() => {}} />
    );
    const view = render(single());
    const dialog = () => screen.getByRole("alertdialog");
    expect(dialog()).toHaveAccessibleDescription(/stops any work in progress/);
    view.rerender(bulk(external.id));
    expect(dialog()).toHaveAccessibleDescription(/stops any work in progress/);
    view.rerender(bulk("other"));
    expect(dialog()).not.toHaveAccessibleDescription(
      /stops any work in progress/,
    );

    events.apply({ type: "external_session_activity", activities: {} });
    const nativeConnection = (external: boolean) =>
      events.apply({
        type: "session_status",
        sessionId: "external",
        sessionStatus: { runState: "idle", external },
      });
    nativeConnection(true);
    view.rerender(single());
    expect(dialog()).toHaveAccessibleDescription(/stops any work in progress/);
    view.rerender(bulk(external.id));
    expect(dialog()).toHaveAccessibleDescription(/stops any work in progress/);
    nativeConnection(false);
    view.rerender(single());
    expect(dialog()).not.toHaveAccessibleDescription(
      /stops any work in progress/,
    );
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

  it("updates external cues from observations without adopting runtime authority", () => {
    const observe = (activity?: string) =>
      events.apply({
        type: "external_session_activity",
        activities: activity ? { external: activity } : {},
      });
    observe("working");
    const view = render(row());
    expect(screen.getByRole("img", { name: "Working in Pi" })).toBeVisible();
    expect(ensureSessionVisible).toHaveBeenCalledWith(external.id);

    observe("invalid");
    view.rerender(row());
    expect(screen.getByRole("img", { name: "Working in Pi" })).toBeVisible();
    observe("blocked");
    view.rerender(row());
    expect(
      screen.getByRole("img", { name: "Waiting for input in Pi" }),
    ).toBeVisible();

    state.sessionStatuses = {
      external: { runState: "conflict", indicator: "attention" },
    };
    observe("working");
    view.rerender(row());
    expect(screen.getByRole("img", { name: "Needs recovery" })).toBeVisible();
    observe("idle");
    expect(state.sessionStatuses.external).toEqual({
      runState: "conflict",
      indicator: "attention",
    });
    state.sessionStatuses = {};
    view.rerender(row());
    expect(screen.getByTitle(/Idle in Pi/)).toBeVisible();
    observe();
    view.rerender(row());
    expect(screen.queryByTitle(/Idle in Pi/)).toBeNull();
  });

});
