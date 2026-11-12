// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  InspirePreferences,
  SessionRuntimeStatus,
  SessionSummary,
} from "../../shared/contracts";
import { createInitialAppState } from "../../src/app-state";
import { Nav } from "../../src/components/Nav";
import {
  hiddenDeletionBlockReason,
  type NavCuration,
  splitNavSections,
} from "../../src/components/nav-model";
import { ProjectGroup, SessionRow } from "../../src/components/NavSessions";
import { compactAge } from "../../src/format";
import { needsYouRows } from "../../src/needs-you";
import { store } from "../../src/store";
import { readNavigationDisclosure } from "../../src/workbench-session";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  sessionSummary,
} from "./helpers";

const alpha = sessionSummary({
  id: "alpha",
  title: "Alpha session",
  cwd: "/work/alpha",
  project: "alpha",
  modified: "2026-07-20T10:00:00Z",
});
const beta = sessionSummary({
  id: "beta",
  title: "Beta session",
  cwd: "/work/beta",
  project: "beta",
  modified: "2026-07-24T10:00:00Z",
});
const gamma = sessionSummary({
  id: "gamma",
  title: "Gamma session",
  cwd: "/work/gamma",
  project: "gamma",
  modified: "2026-07-22T10:00:00Z",
});

const navProps = {
  collapsed: false,
  onToggleNavigation: () => {},
  onNewSession: () => {},
  onSelectSession: () => {},
};

const search = () => screen.getByRole("searchbox", { name: "Search sessions" });
const searchFor = (query: string) =>
  fireEvent.change(search(), { target: { value: query } });
const hiddenToggle = () => screen.getByRole("button", { name: "Hidden" });
const searchStatus = () =>
  document.getElementById(search().getAttribute("aria-describedby")!);

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

async function openNavigation({
  sessions = [alpha, beta],
  preferences,
}: {
  sessions?: SessionSummary[];
  preferences?: Partial<InspirePreferences>;
} = {}) {
  installFakeWebSocket();
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap")) {
      const payload = bootstrapPayload({
        snapshot: activeSnapshot({ sessionId: alpha.id, cwd: alpha.cwd }),
      });
      return {
        body: {
          ...payload,
          preferences: { ...payload.preferences, ...preferences },
        },
      };
    }
    if (url.startsWith("/api/sessions/by-cwd")) {
      const cwds = jsonBody(init).cwds as string[];
      return {
        body: {
          sessions: sessions.filter((session) => cwds.includes(session.cwd)),
        },
      };
    }
    if (url.startsWith("/api/sessions?")) {
      const query =
        new URL(url, "http://local").searchParams.get("q")?.toLowerCase() ?? "";
      const matches = sessions.filter((session) =>
        session.title.toLowerCase().includes(query),
      );
      return { body: sessionPage(matches, matches.length) };
    }
    if (url.startsWith("/api/preferences") && init.method === "PATCH")
      return { body: { ...store.getState().prefs, ...jsonBody(init) } };
    return undefined;
  });
  await store.init();
  await store.loadSessions("");
  const onSelect = vi.fn();
  const nav = () => <Nav {...navProps} onSelectSession={onSelect} />;
  return { nav, onSelect, ...render(nav()) };
}

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

it("reveals a collapsed project for search without persisting the expansion", async () => {
  await openNavigation({ preferences: { navCollapsedGroups: [alpha.cwd] } });
  const project = () => screen.getByRole("button", { name: "alpha" });
  expect(project()).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText(alpha.title)).toBeNull();

  searchFor("alpha");
  expect(
    await screen.findByRole("button", { name: /^Alpha session/ }),
  ).toBeVisible();
  expect(project()).toHaveAttribute("aria-expanded", "true");
  expect(project()).toBeDisabled();

  searchFor("");
  await waitFor(() =>
    expect(project()).toHaveAttribute("aria-expanded", "false"),
  );
  expect(screen.queryByText(alpha.title)).toBeNull();
});

it("repairs an invalid Hidden choice without changing Recent or saving a search expansion", async () => {
  sessionStorage.setItem(
    "inspire:workbench:v1:navigation-disclosures",
    JSON.stringify({ recentSessions: false, hiddenSessions: "true" }),
  );
  const { nav, unmount } = await openNavigation({
    preferences: { hiddenSessionIds: [alpha.id] },
  });
  expect(hiddenToggle()).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(hiddenToggle());
  unmount();
  const view = render(nav());
  expect(hiddenToggle()).toHaveAttribute("aria-expanded", "true");
  expect(readNavigationDisclosure("recentSessions")).toBe(false);
  fireEvent.click(hiddenToggle());

  searchFor("alpha");
  const hidden = await screen.findByRole("region", { name: "Hidden" });
  expect(
    await within(hidden).findByRole("button", { name: /^Alpha session/ }),
  ).toBeVisible();
  expect(hiddenToggle()).toBeDisabled();
  expect(screen.getByRole("button", { name: "Clear Hidden" })).toBeDisabled();
  view.unmount();
  render(nav());
  searchFor("");
  const restored = await screen.findByRole("region", { name: "Hidden" });
  expect(hiddenToggle()).toHaveAttribute("aria-expanded", "false");
  expect(within(restored).queryByText(alpha.title)).toBeNull();
});

it("search reaches an individually hidden session before hidden folder contents", async () => {
  await openNavigation({
    preferences: {
      hiddenProjectCwds: [alpha.cwd],
      hiddenSessionIds: [beta.id],
    },
  });
  act(() => search().focus());
  searchFor("session");
  await screen.findByRole("button", { name: /^Beta session/ });
  expect(searchStatus()).toHaveTextContent(beta.title);
  fireEvent.keyDown(search(), { key: "ArrowDown" });
  expect(searchStatus()).toHaveTextContent(alpha.title);
});

it("preserves search identity through curation and follows the resulting visible order", async () => {
  const { onSelect } = await openNavigation({ sessions: [alpha, beta, gamma] });
  act(() => search().focus());
  searchFor("session");
  await screen.findByRole("button", { name: /^Beta session/ });
  for (const key of ["ArrowDown", "ArrowDown"])
    fireEvent.keyDown(search(), { key });
  expect(searchStatus()).toHaveTextContent(alpha.title);

  fireEvent.click(screen.getByRole("button", { name: 'Pin "Alpha session"' }));
  expect(searchStatus()).toHaveTextContent(alpha.title);
  fireEvent.keyDown(search(), { key: "ArrowDown" });
  expect(searchStatus()).toHaveTextContent(beta.title);

  fireEvent.keyDown(search(), { key: "ArrowUp" });
  fireEvent.click(screen.getByRole("button", { name: 'Hide "Alpha session"' }));
  expect(searchStatus()).toHaveTextContent(alpha.title);
  fireEvent.keyDown(search(), { key: "ArrowUp" });
  fireEvent.keyDown(search(), { key: "Enter" });
  expect(onSelect).toHaveBeenLastCalledWith(gamma.id);

  searchFor("beta");
  fireEvent.keyDown(search(), { key: "Enter" });
  expect(onSelect).toHaveBeenCalledOnce();
  await screen.findByRole("button", { name: /^Beta session/ });
  fireEvent.keyDown(search(), { key: "Enter" });
  expect(onSelect).toHaveBeenLastCalledWith(beta.id);
});

it.each([
  {
    name: "entire collapsed drawer",
    folder: false,
    targets: [alpha.id, beta.id],
    cwd: undefined,
  },
  { name: "one folder", folder: true, targets: [alpha.id], cwd: alpha.cwd },
])("confirms deletion for the $name only", async ({ folder, targets, cwd }) => {
  await openNavigation({
    preferences: {
      hiddenProjectCwds: [alpha.cwd],
      hiddenSessionIds: [beta.id],
    },
  });
  const clear = vi.spyOn(store, "clearHiddenSessions").mockResolvedValue(null);
  if (folder) fireEvent.click(hiddenToggle());
  const trigger = screen.getByRole("button", {
    name: folder ? "Delete all sessions in folder alpha" : "Clear Hidden",
  });
  await waitFor(() => expect(trigger).toBeEnabled());

  fireEvent.click(trigger);
  const dialog = screen.getByRole("alertdialog", {
    name: folder ? "Clear hidden folder?" : "Clear Hidden?",
  });
  const count = folder ? "1 session" : "2 sessions";
  expect(
    within(dialog).getByText(`${folder ? "alpha" : "Hidden"} · ${count}`),
  ).toBeVisible();
  if (cwd) expect(dialog).toHaveAccessibleDescription(new RegExp(cwd));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(clear).not.toHaveBeenCalled();
  expect(hiddenToggle()).toHaveAttribute("aria-expanded", String(folder));

  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: `Delete ${count}` }));
  expect(clear).toHaveBeenCalledExactlyOnceWith(targets, cwd);
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
  const sections = splitNavSections(
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
  const ids = (rows: typeof sections.pinned) => rows.map(({ id }) => id);
  expect(ids(sections.pinned)).toEqual(["pinned-new", "pinned-old"]);
  expect(ids(sections.hidden)).toEqual(["hidden"]);
  expect(
    sections.pinnedGroups.map(({ cwd, sessions }) => [cwd, ids(sessions)]),
  ).toEqual([["/work/archive", ["archived"]]]);
  expect(
    sections.hiddenGroups.map(({ cwd, sessions }) => [cwd, ids(sessions)]),
  ).toEqual([["/work/private", ["hidden-folder-new", "hidden-folder-child"]]]);
  expect(
    sections.groups.map(({ cwd, sessions }) => [cwd, ids(sessions)]),
  ).toEqual([
    ["/work/app", ["recent", "older"]],
    ["/work/team/app", ["other"]],
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
