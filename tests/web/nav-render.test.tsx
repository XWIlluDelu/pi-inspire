// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionRuntimeStatus } from "../../shared/contracts";
import { createInitialAppState } from "../../src/app-state";
import { Nav } from "../../src/components/Nav";
import { ProjectGroup, SessionRow } from "../../src/components/NavSessions";
import {
  buildSessionCatalog,
  hiddenDeletionBlockReason,
  type NavCuration,
  sectionSessions,
} from "../../src/components/nav-model";
import { compactAge } from "../../src/format";
import { needsYouRows } from "../../src/needs-you";
import { store } from "../../src/store";
import { sessionSummary } from "./helpers";

const alpha = sessionSummary({
  id: "alpha",
  title: "Alpha session",
  cwd: "/work/alpha",
  project: "alpha",
  modified: "2026-07-20T10:00:00Z",
});
const navProps = {
  collapsed: false,
  onToggleNavigation: () => {},
  onNewSession: () => {},
  onSelectSession: () => {},
};

it("updates a mounted row's relative age without a session update", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(alpha.modified));
    const row = render(
      <SessionRow
        session={alpha}
        selectedSessionId={null}
        onSelect={() => {}}
      />,
    );
    try {
      expect(screen.getByText("now")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(120_000));
      expect(screen.getByText("2m")).toBeInTheDocument();
    } finally {
      row.unmount();
    }
  } finally {
    vi.useRealTimers();
  }
});

describe("session navigation search captions", () => {
  it.each(["/work/alpha", "C:\\work\\alpha"])(
    "reveals a matched parent directory without a basename collision: %s",
    (cwd) => {
      const props = {
        group: { cwd, name: "alpha", sessions: [{ ...alpha, cwd }] },
        searching: true,
        searchQuery: '"WORK"',
        showContext: false,
        selectedSessionId: null,
        onSelectSession: vi.fn(),
      };
      const { container, rerender } = render(<ProjectGroup {...props} />);
      expect(container.querySelector(".nav__group-context")).toHaveTextContent(
        /^@work$/,
      );
      expect(
        container.querySelector(".nav__group-context .search-match"),
      ).toHaveTextContent(/^work$/);
      rerender(<ProjectGroup {...props} searchQuery="alpha" />);
      expect(container.querySelector(".nav__group-context")).toBeNull();
      // Existing basename disambiguation survives regardless of the query.
      rerender(<ProjectGroup {...props} searchQuery="alpha" showContext />);
      expect(container.querySelector(".nav__group-context")).toHaveTextContent(
        "work",
      );
    },
  );

  it("keeps matched parent context in cross-project session captions only during search", () => {
    const props = {
      session: alpha,
      selectedSessionId: null,
      showProject: true,
      onSelect: vi.fn(),
    };
    const { container, rerender } = render(
      <SessionRow {...props} searchQuery="work" />,
    );
    expect(container.querySelector(".nav__row-project")).toHaveTextContent(
      "work/alpha",
    );
    expect(
      container.querySelector(".nav__row-project .search-match"),
    ).toHaveTextContent("work");
    expect(container.querySelector(".nav__row-age")).toBeNull();
    rerender(<SessionRow {...props} searchQuery="" />);
    expect(container.querySelector(".nav__row-age")).not.toBeNull();
    expect(container.querySelector(".nav__row-project")).toHaveTextContent(
      /^alpha$/,
    );
    rerender(
      <SessionRow
        {...props}
        session={{ ...alpha, title: "Work plan" }}
        searchQuery="work"
      />,
    );
    expect(container.querySelector(".nav__row-project")).toHaveTextContent(
      /^alpha$/,
    );
    expect(container.querySelector(".nav__row-age")).not.toBeNull();
    rerender(<SessionRow {...props} searchQuery="re:work" />);
    expect(container.querySelector(".nav__row-project")).toHaveTextContent(
      /^alpha$/,
    );
  });
});

it("refreshes a populated session list quietly and explains an empty initial wait", () => {
  const snapshot = vi.spyOn(store, "getState").mockReturnValue({
    ...createInitialAppState(),
    sessions: [alpha],
    sessionListLoading: true,
    sessionListOperation: "refresh",
  });
  const populated = render(<Nav {...navProps} />);
  expect(screen.getByRole("button", { name: /^Alpha session/ })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Refreshing sessions…" }),
  ).toBeNull();
  populated.unmount();
  snapshot.mockReturnValue({ ...snapshot(), sessions: [] });
  render(<Nav {...navProps} />);
  expect(
    screen.getByRole("button", { name: "Refreshing sessions…" }),
  ).toBeDisabled();
  expect(screen.queryByText("No sessions yet")).toBeNull();
});

const curation = (overrides: Partial<NavCuration> = {}): NavCuration => ({
  pinnedSessionIds: [],
  pinnedProjectCwds: [],
  hiddenProjectCwds: [],
  hiddenSessionIds: [],
  ...overrides,
});

describe("hidden deletion eligibility", () => {
  const idle = (): Parameters<typeof hiddenDeletionBlockReason>[1] => ({
    openingSessionId: null,
    sessionQuery: "",
    sessionListLoading: false,
    sessionListLoadingOlder: false,
    sessionListHydrating: false,
    sessionListError: null,
    sessionListIssues: [],
    curationPending: false,
    clearingHidden: false,
    deletingSessionId: null,
  });
  const targets = [sessionSummary({ id: "target" })];

  it.each([
    ["opening", { openingSessionId: "target" }, /opening/],
    ["partial catalog", { sessionListHydrating: true }, /loading/],
    ["search", { sessionQuery: "term" }, /searching/],
    ["another deletion", { deletingSessionId: "elsewhere" }, /deletion/],
  ] as const)(
    "blocks %s targets or an incomplete selection",
    (_, patch, message) => {
      expect(
        hiddenDeletionBlockReason(targets, { ...idle(), ...patch }),
      ).toMatch(message);
    },
  );

  it("keeps complete-set deletion unavailable while some catalog sources are unknown", () => {
    expect(
      hiddenDeletionBlockReason(targets, {
        ...idle(),
        sessionListIssues: [{ path: "/offline", message: "Access denied" }],
      }),
    ).toMatch(/unavailable session sources/);
  });

  it("allows deletion of a complete settled selection", () => {
    expect(hiddenDeletionBlockReason(targets, idle())).toBeNull();
  });
});

function navModelRow(id: string, folder: string, day: number) {
  return sessionSummary({
    id,
    cwd: `/work/${folder}`,
    project: folder,
    modified: new Date(Date.UTC(2026, 6, day)).toISOString(),
  });
}

it("files each session once and orders projects by newest activity", () => {
  const catalog = buildSessionCatalog(
    [
      navModelRow("pinned-old", "archive", 15),
      navModelRow("older", "app", 20),
      navModelRow("other", "team/app", 21),
      navModelRow("recent", "app", 22),
      navModelRow("pinned-new", "app", 24),
      navModelRow("archived", "archive", 16),
      navModelRow("hidden", "archive", 23),
      navModelRow("hidden-folder-child", "private", 21),
      navModelRow("hidden-folder-new", "private", 25),
    ],
    curation({
      pinnedSessionIds: ["pinned-old", "pinned-new", "hidden"],
      pinnedProjectCwds: ["/work/archive", "/work/private"],
      hiddenSessionIds: ["hidden", "hidden-folder-child"],
      hiddenProjectCwds: ["/work/private"],
    }),
  );
  const sectionRows = (sections: typeof catalog.all) =>
    sections.map((section) => [
      section.kind === "folder" ? section.group.cwd : section.kind,
      sectionSessions(section).map(({ id }) => id),
    ]);
  expect(sectionRows(catalog.all)).toEqual([
    ["pinned", ["pinned-new", "pinned-old"]],
    ["/work/archive", ["archived"]],
    ["/work/app", ["recent", "older"]],
    ["/work/team/app", ["other"]],
  ]);
  expect(sectionRows(catalog.hidden)).toEqual([
    ["hidden", ["hidden"]],
    ["/work/private", ["hidden-folder-new", "hidden-folder-child"]],
  ]);
});

it("orders Needs you by urgency then activity, including blocked native Pi", () => {
  const sessions = [
    "older-completion",
    "failed",
    "running",
    "selected",
    "blocked-pi",
    "working-pi",
    "newer-completion",
  ].map((id, index) =>
    sessionSummary({ id, modified: new Date(index * 1000).toISOString() }),
  );
  const rows = needsYouRows(
    sessions,
    {
      "older-completion": { runState: "idle", indicator: "completed" },
      failed: { runState: "failed", indicator: "failed" },
      running: { runState: "running", indicator: "running" },
      selected: { runState: "running", needsInput: true },
      "newer-completion": { runState: "idle", indicator: "completed" },
    },
    { "blocked-pi": "blocked", "working-pi": "working" },
    "selected",
    null,
  );
  expect(rows.map(({ session, reason }) => [session.id, reason])).toEqual([
    ["blocked-pi", "attention"],
    ["selected", "attention"],
    ["failed", "failed"],
    ["newer-completion", "completed"],
    ["older-completion", "completed"],
  ]);
});

it("clears the viewed outcome while keeping its row in Needs you until selection changes", () => {
  const sessions = ["completed", "failed"].map((id) => sessionSummary({ id }));
  const statuses: Record<string, SessionRuntimeStatus> = {
    completed: { runState: "idle", indicator: "completed" },
    failed: { runState: "failed", indicator: "failed" },
  };
  const retained = { id: "completed", reason: "completed" as const };
  const visible = (selected: string, keep: typeof retained | null) =>
    needsYouRows(sessions, statuses, {}, selected, keep).map(
      ({ session, reason }) => [session.id, reason],
    );

  expect(visible("completed", null)).toEqual([["failed", "failed"]]);
  expect(visible("completed", retained)).toEqual([
    ["failed", "failed"],
    ["completed", null],
  ]);
  statuses.completed = { runState: "idle" };
  expect(visible("failed", retained)).toEqual([]);
});

describe("compactAge", () => {
  const now = Date.parse("2026-07-27T12:00:00Z");

  it("compresses older recency to one unit and falls back to a short date", () => {
    expect(compactAge("2026-07-27T09:00:00Z", now)).toBe("3h");
    expect(compactAge("2026-07-22T12:00:00Z", now)).toBe("5d");
    expect(compactAge("2026-01-03T12:00:00Z", now)).toMatch(/\d/);
  });

  it("reads empty for an unparseable timestamp and never goes negative", () => {
    expect(compactAge("not a date", now)).toBe("");
    expect(compactAge("2026-07-27T12:05:00Z", now)).toBe("now");
  });
});
