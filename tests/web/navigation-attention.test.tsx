// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AppState, createInitialAppState } from "../../src/app-state";
import { AppTopbar } from "../../src/components/AppTopbar";
import { Nav } from "../../src/components/Nav";
import { store } from "../../src/store";

let state: AppState;
const onToggle = vi.fn();
const listeners = new Set<() => void>();

beforeEach(() => {
  state = createInitialAppState();
  state.sessionId = "selected";
  state.gitStatus = { kind: "not-repository" };
  onToggle.mockClear();
  listeners.clear();
  vi.spyOn(store, "getState").mockImplementation(() => state);
  vi.spyOn(store, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
});

function navigation(surface: "rail" | "mobile", expanded = false) {
  return surface === "rail" ? (
    <Nav
      collapsed={!expanded}
      onToggleNavigation={onToggle}
      onNewSession={() => {}}
      onSelectSession={() => {}}
    />
  ) : (
    <AppTopbar
      narrowViewport
      mobileNavOpen={expanded}
      settingsOpen={false}
      onToggleNavigation={onToggle}
      onOpenCommandPalette={() => {}}
      onExportSession={() => {}}
      onToggleSettings={() => {}}
      onToggleResources={() => {}}
    />
  );
}

describe.each(["rail", "mobile"] as const)(
  "%s navigation attention",
  (surface) => {
    const button = () =>
      screen.getByRole("button", {
        name: surface === "rail" ? "Expand navigation" : "Toggle navigation",
      });

    it("counts unseen completions without counting the selected or running sessions", () => {
      state.sessionStatuses = {
        selected: { runState: "idle", indicator: "failed" },
        completed: { runState: "idle", indicator: "completed" },
        running: { runState: "running", indicator: "running" },
        idle: { runState: "idle" },
      };
      render(navigation(surface));
      const toggle = button();
      expect(toggle).toHaveAccessibleDescription(
        "1 other session needs attention",
      );
      expect(
        toggle.querySelector(".navigation-toggle__attention"),
      ).toHaveTextContent("1");
      expect(
        toggle.querySelector(".navigation-toggle__attention--urgent"),
      ).toBeNull();
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      expect(onToggle).toHaveBeenCalledOnce();
    });

    it.each(["failed", "attention"] as const)(
      "prioritizes %s over successful completion",
      (indicator) => {
        state.sessionStatuses = {
          completed: { runState: "idle", indicator: "completed" },
          urgent: { runState: "idle", indicator },
        };
        render(navigation(surface));
        expect(button()).toHaveAccessibleDescription(
          "2 other sessions need attention",
        );
        expect(
          button().querySelector(".navigation-toggle__attention--urgent"),
        ).toHaveTextContent("2");
      },
    );

    it("caps the visible count at 9+ while preserving the full accessible count", () => {
      state.sessionStatuses = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `completed-${index}`,
          { runState: "idle", indicator: "completed" },
        ]),
      );
      render(navigation(surface));
      expect(button()).toHaveTextContent("9+");
      expect(button()).toHaveAccessibleDescription(
        "12 other sessions need attention",
      );
    });

    it("updates live and removes the badge after attention is consumed", () => {
      render(navigation(surface));
      expect(button()).not.toHaveAttribute("aria-describedby");
      act(() => {
        state = {
          ...state,
          sessionStatuses: {
            completed: { runState: "idle", indicator: "completed" },
          },
        };
        for (const listener of listeners) listener();
      });
      expect(button()).toHaveAccessibleDescription(
        "1 other session needs attention",
      );
      act(() => {
        state = {
          ...state,
          sessionStatuses: { completed: { runState: "idle" } },
        };
        for (const listener of listeners) listener();
      });
      expect(
        button().querySelector(".navigation-toggle__attention"),
      ).toBeNull();
      expect(button()).not.toHaveAttribute("aria-describedby");
    });
  },
);

it("leaves expanded desktop navigation to its session-row indicators", () => {
  state.sessionStatuses = {
    completed: { runState: "idle", indicator: "completed" },
  };
  const { container } = render(navigation("rail", true));
  expect(
    screen.getByRole("button", { name: "Collapse navigation" }),
  ).not.toHaveAttribute("aria-describedby");
  expect(container.querySelector(".navigation-toggle__attention")).toBeNull();
});

it("respects the visible selection when the rail shows Welcome", () => {
  state.sessionStatuses = {
    selected: { runState: "idle", indicator: "completed" },
  };
  render(
    <Nav
      collapsed
      selectedSessionId={null}
      onToggleNavigation={onToggle}
      onNewSession={() => {}}
      onSelectSession={() => {}}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Expand navigation" }),
  ).toHaveAccessibleDescription("1 other session needs attention");
});
