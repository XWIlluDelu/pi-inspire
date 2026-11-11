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
  SessionSummary,
} from "../../shared/contracts";
import { createInitialAppState } from "../../src/app-state";
import { Nav } from "../../src/components/Nav";
import { ProjectGroup, SessionRow } from "../../src/components/NavSessions";
import { store } from "../../src/store";
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
      rerender(<ProjectGroup {...props} searchQuery="" searching={false} />);
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

it("orders Needs you by activity even when All promotes a pin", () => {
  const state = createInitialAppState();
  const waiting = { runState: "running", needsInput: true } as const;
  const archived = { ...gamma, id: "archived" };
  vi.spyOn(store, "getState").mockReturnValue({
    ...state,
    sessions: [alpha, beta, gamma, archived],
    prefs: {
      ...state.prefs,
      pinnedSessionIds: [alpha.id],
      pinnedProjectCwds: [gamma.cwd],
      hiddenSessionIds: [archived.id],
    },
    sessionStatuses: {
      alpha: waiting,
      beta: waiting,
      gamma: waiting,
      archived: waiting,
    },
  });
  render(<Nav {...navProps} />);
  expect(
    within(screen.getByRole("region", { name: "Pinned" })).getByText(
      alpha.title,
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Needs you (3)" }));
  const needsYou = screen.getByRole("region", {
    name: "Sessions that need you",
  });
  expect(
    [...needsYou.querySelectorAll("[data-session-id]")].map((row) =>
      row.getAttribute("data-session-id"),
    ),
  ).toEqual([beta.id, gamma.id, alpha.id]);
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

it("remembers Hidden disclosure without persisting a temporary search expansion", async () => {
  const { nav, unmount } = await openNavigation({
    preferences: { hiddenSessionIds: [alpha.id] },
  });
  expect(hiddenToggle()).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(hiddenToggle());
  unmount();
  const view = render(nav());
  expect(hiddenToggle()).toHaveAttribute("aria-expanded", "true");
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
  onSelect.mockClear();
  fireEvent.keyDown(search(), { key: "Enter" });
  expect(onSelect).not.toHaveBeenCalled();
  await screen.findByRole("button", { name: /^Beta session/ });
  fireEvent.keyDown(search(), { key: "Enter" });
  expect(onSelect).toHaveBeenCalledWith(beta.id);
});

it("leaves composition and modified keys to the search input, then clears before blurring", async () => {
  const { onSelect } = await openNavigation();
  act(() => search().focus());
  searchFor("session");
  await screen.findByRole("button", { name: /^Beta session/ });
  expect(searchStatus()).toHaveTextContent(beta.title);
  fireEvent.compositionStart(search());
  for (const key of ["ArrowDown", "Enter", "Escape"])
    fireEvent.keyDown(search(), { key });
  fireEvent.compositionEnd(search());
  fireEvent.keyDown(search(), { key: "ArrowDown", isComposing: true });
  fireEvent.keyDown(search(), { key: "Enter", keyCode: 229 });
  fireEvent.keyDown(search(), { key: "ArrowDown", shiftKey: true });
  expect(searchStatus()).toHaveTextContent(beta.title);
  expect(onSelect).not.toHaveBeenCalled();
  expect(search()).toHaveValue("session");

  fireEvent.keyDown(search(), { key: "Escape" });
  expect(search()).toHaveValue("");
  expect(search()).toHaveFocus();
  fireEvent.keyDown(search(), { key: "Escape" });
  expect(search()).not.toHaveFocus();
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
