// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const groupNames = () =>
  [...document.querySelectorAll(".nav__group-name")].map(
    (node) => node.textContent,
  );
/** The session list only: the workspace explorer below it names the visible
 * session's folder too. */
const list = () => within(document.querySelector(".nav__list") as HTMLElement);

let deletedSessions: Set<string>;
let extraSessions: (typeof alpha)[];
let searchPageSize: number | undefined;

describe("session navigation controls", () => {
  beforeEach(async () => {
    deletedSessions = new Set();
    extraSessions = [];
    searchPageSize = undefined;
    installFakeWebSocket();
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: activeSnapshot({
              sessionId: "alpha",
              cwd: "/work/alpha",
            }),
          }),
        };
      }
      if (url.startsWith("/api/git/status"))
        return {
          body: {
            kind: "repository",
            head: { kind: "branch", name: "main", oid: "0123456789abcdef" },
            files: [
              {
                path: {
                  id: "b3RoZXIvY2hhbmdlZC50cw",
                  display: "other/changed.ts",
                  utf8Path: "other/changed.ts",
                  workspacePath: "other/changed.ts",
                },
                unstaged: { kind: "modified" },
                untracked: false,
              },
            ],
            total: 1,
            truncated: false,
            groups: {
              conflicted: [],
              staged: [],
              unstaged: ["b3RoZXIvY2hhbmdlZC50cw"],
              untracked: [],
            },
          },
        };
      if (url.startsWith("/api/files/list")) {
        const dir = new URL(url, "http://local").searchParams.get("dir") ?? "";
        return {
          body: {
            entries:
              dir === "other"
                ? [{ name: "changed.ts", type: "file" }]
                : [
                    { name: "other", type: "dir" },
                    { name: "changed.ts", type: "file" },
                  ],
          },
        };
      }
      if (url.startsWith("/api/sessions/by-cwd")) {
        const cwds = jsonBody(init).cwds as string[];
        return {
          body: {
            sessions: [alpha, beta, ...extraSessions].filter(
              (session) =>
                cwds.includes(session.cwd) && !deletedSessions.has(session.id),
            ),
          },
        };
      }
      if (url.startsWith("/api/sessions/by-id"))
        return { body: { sessions: [] } };
      if (
        url.startsWith("/api/sessions/clear-hidden") &&
        init.method === "POST"
      ) {
        const sessionIds = new Set(
          (jsonBody(init).sessionIds as string[] | undefined) ?? [],
        );
        const targets = [alpha, beta, ...extraSessions].filter(
          (session) =>
            sessionIds.has(session.id) && !deletedSessions.has(session.id),
        );
        for (const session of targets) deletedSessions.add(session.id);
        const prefs = store.getState().prefs;
        const projectCwd = jsonBody(init).projectCwd as string | undefined;
        const hiddenProjectCwds = new Set(
          projectCwd === undefined ? prefs.hiddenProjectCwds : [projectCwd],
        );
        return {
          body: {
            deleted: targets.map((session) => ({
              sessionId: session.id,
              disposition: "trashed",
            })),
            preferences: {
              ...prefs,
              pinnedSessionIds: prefs.pinnedSessionIds.filter(
                (id) => !sessionIds.has(id),
              ),
              hiddenSessionIds:
                projectCwd === undefined
                  ? []
                  : prefs.hiddenSessionIds.filter((id) => !sessionIds.has(id)),
              pinnedProjectCwds: prefs.pinnedProjectCwds.filter(
                (cwd) => !hiddenProjectCwds.has(cwd),
              ),
              hiddenProjectCwds: prefs.hiddenProjectCwds.filter(
                (cwd) => !hiddenProjectCwds.has(cwd),
              ),
              navCollapsedGroups: prefs.navCollapsedGroups.filter(
                (cwd) => !hiddenProjectCwds.has(cwd),
              ),
            },
          },
        };
      }
      if (url.startsWith("/api/sessions/") && init.method === "DELETE") {
        const sessionId = decodeURIComponent(url.split("/").at(-1)!);
        deletedSessions.add(sessionId);
        const prefs = store.getState().prefs;
        return {
          body: {
            sessionId,
            disposition: "trashed",
            preferences: {
              ...prefs,
              pinnedSessionIds: prefs.pinnedSessionIds.filter(
                (id) => id !== sessionId,
              ),
              hiddenSessionIds: prefs.hiddenSessionIds.filter(
                (id) => id !== sessionId,
              ),
            },
          },
        };
      }
      if (url.startsWith("/api/sessions")) {
        const query =
          new URL(url, "http://local").searchParams.get("q")?.toLowerCase() ??
          "";
        const sessions = [alpha, beta, ...extraSessions].filter(
          (session) =>
            !deletedSessions.has(session.id) &&
            session.title.toLowerCase().includes(query),
        );
        const offset = Number(
          new URL(url, "http://local").searchParams.get("offset") ?? 0,
        );
        const limit = searchPageSize ?? 40;
        return {
          body: sessionPage(
            sessions.slice(offset, offset + limit),
            sessions.length,
            offset,
            limit,
          ),
        };
      }
      if (url.startsWith("/api/preferences") && init.method === "PATCH")
        return { body: { ...store.getState().prefs, ...jsonBody(init) } };
      return undefined;
    });
    await store.init("token");
    await store.loadSessions("");
    await waitFor(() => expect(store.getState().sessions).toHaveLength(2));
  });

  it("renders brand lockup and provides new session action in both nav widths", () => {
    const onNewSession = vi.fn();
    const { container, rerender } = render(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed={false}
        onNewSession={onNewSession}
        onSelectSession={() => undefined}
      />,
    );
    const newSessionBtn = screen.getByRole("button", { name: "New session" });
    expect(newSessionBtn).not.toHaveAttribute("aria-current");
    expect(container.querySelector(".nav__brand-icon")).not.toBeNull();
    expect(container.querySelector(".wordmark")).toHaveTextContent("INSΠRE");
    expect(
      container.querySelector(".nav__brand-lockup")?.closest("button"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Collapse navigation" }),
    ).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(newSessionBtn);
    expect(onNewSession).toHaveBeenCalledOnce();

    rerender(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed
        onNewSession={onNewSession}
        onSelectSession={() => undefined}
      />,
    );
    const railBrand = screen.getByRole("button", { name: "Expand navigation" });
    expect(railBrand.querySelector(".nav__brand-icon--rail")).not.toBeNull();
    fireEvent.click(railBrand);
    expect(onNewSession).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(onNewSession).toHaveBeenCalledTimes(2);
  });

  it("keeps the runtime owner unselected while the New session surface is visible", () => {
    render(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed={false}
        selectedSessionId={null}
        onNewSession={() => undefined}
        onSelectSession={() => undefined}
      />,
    );
    const alphaRow = list()
      .getByText("Alpha session")
      .closest(".nav__row") as HTMLElement;
    expect(alphaRow).not.toHaveClass("nav__row--active");
    expect(alphaRow.querySelector(".nav__row-main")).not.toHaveAttribute(
      "aria-current",
    );
    expect(
      screen.queryByRole("region", { name: "Workspace files" }),
    ).not.toBeInTheDocument();
  });

  it.each(["/work/alpha", "C:\\work\\alpha"])(
    "reveals a matched parent directory without a basename collision: %s",
    (cwd) => {
      const props = {
        group: { cwd, name: "alpha", sessions: [{ ...alpha, cwd }] },
        headingId: "parent-match-group",
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

  it("keeps the folder icon in sync with pointer, keyboard, and search disclosure without selecting", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={onSelect}
      />,
    );

    const alphaGroup = list().getByRole("button", { name: "alpha" });
    expect(alphaGroup).toHaveAttribute("aria-expanded", "true");
    expect(alphaGroup.querySelectorAll("svg")).toHaveLength(1);
    expect(alphaGroup.querySelector(".lucide-folder-open")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await user.click(alphaGroup);
    expect(alphaGroup).toHaveAttribute("aria-expanded", "false");
    expect(alphaGroup.querySelector(".lucide-folder")).not.toBeNull();
    expect(screen.queryByText("Alpha session")).not.toBeInTheDocument();
    expect(alphaGroup.closest("h2")).toHaveClass("nav__group-title--active");

    await user.keyboard("{Enter}");
    expect(alphaGroup).toHaveAttribute("aria-expanded", "true");
    expect(alphaGroup.querySelector(".lucide-folder-open")).not.toBeNull();
    expect(alphaGroup.closest("h2")).not.toHaveClass(
      "nav__group-title--active",
    );
    await user.keyboard(" ");
    expect(alphaGroup).toHaveAttribute("aria-expanded", "false");
    expect(alphaGroup.querySelector(".lucide-folder")).not.toBeNull();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search sessions" }),
      { target: { value: "alpha" } },
    );
    const searchAlphaGroup = await list().findByRole("button", {
      name: "alpha",
    });
    expect(searchAlphaGroup).toHaveAttribute("aria-expanded", "true");
    expect(
      searchAlphaGroup.querySelector(".lucide-folder-open"),
    ).not.toBeNull();
    expect(searchAlphaGroup).toBeDisabled();
    expect(searchAlphaGroup.querySelector(".search-match")).toHaveTextContent(
      "alpha",
    );
    expect(
      document.querySelector(".nav__row-name .search-match"),
    ).toHaveTextContent("Alpha");
    expect(
      screen.getByRole("button", { name: /^Alpha session/ }),
    ).toBeInTheDocument();

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search sessions" }),
      { target: { value: "" } },
    );
    const restoredAlphaGroup = await list().findByRole("button", {
      name: "alpha",
    });
    expect(restoredAlphaGroup).toHaveAttribute("aria-expanded", "false");
    expect(restoredAlphaGroup.querySelector(".lucide-folder")).not.toBeNull();
    fireEvent.click(restoredAlphaGroup);
    fireEvent.click(
      screen.getByRole("button", { name: 'Pin "Alpha session"' }),
    );

    await screen.findByRole("heading", { name: "Pinned" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: 'Unpin "Alpha session"' }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("alpha", { selector: ".nav__row-project" }),
    ).toBeInTheDocument();
  });

  it("keeps Hidden in a bottom drawer with keyboard disclosure, search, and restore", async () => {
    const user = userEvent.setup();
    render(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: 'Hide "Alpha session"' }),
    );
    const hiddenHeading = await screen.findByRole("heading", {
      name: "Hidden",
    });
    const toggle = screen.getByRole("button", { name: "Hidden" });
    expect(
      hiddenHeading.querySelector(".nav__hidden-count")?.parentElement,
    ).toBe(toggle);
    const drawer = hiddenHeading.closest("section")!;
    expect(drawer.closest(".nav__list")).toBeNull();
    expect(drawer.previousElementSibling).toHaveClass("explorer");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Clear Hidden" })).toBeVisible();
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const hiddenContent = document.getElementById(
      toggle.getAttribute("aria-controls")!,
    );
    expect(hiddenContent).toHaveClass("nav__hidden-content");
    expect(hiddenContent?.previousElementSibling).toBe(hiddenHeading);
    expect(hiddenHeading).toHaveClass("nav__dock-heading");
    expect(toggle).toHaveClass("nav__dock-toggle");
    expect(document.querySelector(".explorer__header")).toHaveClass(
      "nav__dock-toggle",
    );
    const clear = within(hiddenHeading).getByRole("button", {
      name: "Clear Hidden",
    });
    expect(clear).toBeVisible();
    expect(toggle.contains(clear)).toBe(false);
    expect(
      within(hiddenContent!).queryByRole("button", { name: "Clear Hidden" }),
    ).toBeNull();
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Hidden starts closed, and its folder disappears with its last session.
    expect(screen.queryByText("Alpha session")).not.toBeInTheDocument();
    expect(groupNames()).toEqual(["beta", "Hidden"]);

    // Search reveals the match without reclassifying it out of Hidden.
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search sessions" }),
      { target: { value: "alpha" } },
    );
    await screen.findByRole("heading", { name: "Hidden" });
    expect(screen.getByRole("button", { name: "Hidden" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear Hidden" })).toBeDisabled();
    const hiddenSection = document.querySelector(
      ".nav__group--hidden",
    ) as HTMLElement;
    expect(
      await within(hiddenSection).findByRole("button", {
        name: /^Alpha session/,
      }),
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search sessions" }),
      { target: { value: "" } },
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Hidden" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
    fireEvent.click(
      screen.getByRole("button", { name: 'Restore "Alpha session"' }),
    );
    await waitFor(() => expect(groupNames()).toEqual(["beta", "alpha"]));
    expect(store.getState().prefs.hiddenSessionIds).toEqual([]);
  });

  it("restores a child from a hidden folder without revealing its other sessions", async () => {
    extraSessions = [
      { ...alpha, id: "alpha-sibling", title: "Other analysis" },
    ];
    await store.refreshSessions();
    render(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide folder alpha" }));
    await waitFor(() =>
      expect(store.getState().sessionListHydrating).toBe(false),
    );
    await store.loadSessions("Alpha session");
    const hiddenSection = document.querySelector(
      ".nav__group--hidden",
    ) as HTMLElement;
    const restore = within(hiddenSection).getByRole("button", {
      name: 'Restore "Alpha session"',
    });
    expect(
      within(hiddenSection).getByRole("button", {
        name: 'Delete "Alpha session"',
      }),
    ).toBeInTheDocument();
    fireEvent.click(restore);
    await waitFor(() =>
      expect(store.getState().prefs.hiddenProjectCwds).toEqual([]),
    );
    expect(store.getState().prefs.hiddenSessionIds).toEqual(["alpha-sibling"]);
    await store.loadSessions("");
    expect(
      list().getByRole("button", { name: /^Alpha session/ }),
    ).toBeInTheDocument();
    expect(
      list().queryByRole("button", { name: /^Other analysis/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps a hidden folder intact when its child restore lookup fails", async () => {
    render(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide folder alpha" }));
    await waitFor(() =>
      expect(store.getState().sessionListHydrating).toBe(false),
    );
    await store.loadSessions("Alpha session");
    installFetch((url) =>
      url.startsWith("/api/sessions/by-cwd")
        ? { status: 503, body: { error: "Folder lookup failed" } }
        : undefined,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: 'Restore "Alpha session"',
      }),
    );
    await waitFor(() =>
      expect(
        store
          .getState()
          .notices.some((notice) => notice.text === "Folder lookup failed"),
      ).toBe(true),
    );
    expect(store.getState().prefs.hiddenProjectCwds).toEqual([alpha.cwd]);
    expect(store.getState().prefs.hiddenSessionIds).toEqual([]);
  });

  it("clears every session from the collapsed Hidden header without expanding it", async () => {
    render(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={() => undefined}
      />,
    );

    extraSessions = [gamma];
    await store.refreshSessions();
    await screen.findByText("Gamma session");
    fireEvent.click(
      screen.getByRole("button", { name: 'Hide "Beta session"' }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide folder gamma" }));
    await screen.findByRole("heading", { name: "Hidden" });
    expect(screen.getByRole("button", { name: "Hidden" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      screen.queryByRole("button", {
        name: "Delete all sessions in folder gamma",
      }),
    ).not.toBeInTheDocument();

    const clearHidden = screen.getByRole("button", { name: "Clear Hidden" });
    await waitFor(() => expect(clearHidden).toBeEnabled());
    fireEvent.click(clearHidden);
    const dialog = screen.getByRole("alertdialog", {
      name: "Clear Hidden?",
    });
    expect(within(dialog).getByText("Hidden · 2 sessions")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Project files and project folders are unchanged.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Hidden" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear Hidden" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 2 sessions" }));
    await waitFor(() => {
      expect(screen.queryByText("Beta session")).not.toBeInTheDocument();
      expect(screen.queryByText("Gamma session")).not.toBeInTheDocument();
    });
    expect(deletedSessions).toEqual(new Set(["beta", "gamma"]));
    expect(store.getState().prefs.hiddenSessionIds).toEqual([]);
    expect(store.getState().prefs.hiddenProjectCwds).toEqual([]);
  });

  it("clears one hidden folder without deleting other folders or independent hidden sessions", async () => {
    const other = sessionSummary({
      id: "gamma",
      title: "Other folder",
      cwd: "/work/gamma",
    });
    const standalone = sessionSummary({
      id: "standalone",
      title: "Independent",
      cwd: "/work/independent",
    });
    extraSessions = [other, standalone];
    render(
      <Nav
        collapsed={false}
        onToggleNavigation={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    await store.refreshSessions();
    await screen.findByText("Independent");
    fireEvent.click(list().getByRole("button", { name: "Hide folder beta" }));
    fireEvent.click(list().getByRole("button", { name: "Hide folder gamma" }));
    fireEvent.click(list().getByRole("button", { name: 'Hide "Independent"' }));
    fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete all sessions in folder beta",
      }),
    );
    const dialog = screen.getByRole("alertdialog", {
      name: "Clear hidden folder?",
    });
    expect(within(dialog).getByText("beta · 1 session")).toBeTruthy();
    expect(
      within(dialog).getByText(
        /Other hidden sessions and folders are unchanged/,
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete 1 session" }),
    );
    await waitFor(() => expect(deletedSessions).toEqual(new Set([beta.id])));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(store.getState().prefs.hiddenProjectCwds).toEqual([other.cwd]);
    expect(store.getState().prefs.hiddenSessionIds).toEqual([standalone.id]);
    expect(store.getState().sessionId).toBe(alpha.id);
  });

  it("clears the selected idle folder directly and leaves unrelated Hidden folders intact", async () => {
    render(
      <Nav
        collapsed={false}
        onToggleNavigation={vi.fn()}
        onNewSession={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    fireEvent.click(list().getByRole("button", { name: "Hide folder alpha" }));
    fireEvent.click(list().getByRole("button", { name: "Hide folder beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Clear Hidden" }),
      ).toBeEnabled(),
    );
    const selected = screen.getByRole("button", {
      name: "Delete all sessions in folder alpha",
    });
    expect(selected).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: "Delete all sessions in folder beta",
      }),
    ).toBeEnabled();
    fireEvent.click(selected);
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).queryByText(/Pi terminal|Pi process/)).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete 1 session" }),
    );
    await waitFor(() => expect(deletedSessions).toEqual(new Set([alpha.id])));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(store.getState().sessionId).toBeNull();
    expect(store.getState().prefs.hiddenProjectCwds).toEqual([beta.cwd]);
  });

  it("deletes only through Hidden after an explicit confirmation", async () => {
    render(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: 'Hide "Beta session"' }),
    );
    await screen.findByRole("heading", { name: "Hidden" });
    fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
    expect(
      screen.queryByRole("button", { name: 'Pin "Beta session"' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: 'Hide "Beta session"' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: 'Restore "Beta session"' }),
    ).toBeEnabled();

    const deleteButton = screen.getByRole("button", {
      name: 'Delete "Beta session"',
    });
    fireEvent.click(deleteButton);
    const dialog = screen.getByRole("alertdialog", { name: "Delete session?" });
    expect(within(dialog).getByText("Beta session")).toBeInTheDocument();
    expect(within(dialog).queryByText("beta")).not.toBeInTheDocument();
    const description = dialog.querySelector("#session-delete-description");
    expect(description).not.toBeNull();
    expect(
      Array.from(description!.children).map((line) => line.textContent),
    ).toEqual([
      "This session will be moved to Trash.",
      "If Trash is unavailable, it will be permanently deleted.",
      "Forked sessions remain; project files are unchanged.",
    ]);
    expect(within(dialog).queryByText(/another Pi process/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("alertdialog", { name: "Delete session?" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Beta session")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: 'Delete "Beta session"' }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
    await waitFor(() =>
      expect(screen.queryByText("Beta session")).not.toBeInTheDocument(),
    );
    expect(deletedSessions).toEqual(new Set(["beta"]));
    expect(store.getState().notices.at(-1)?.text).toBe(
      "Session moved to Trash",
    );
    expect(store.getState().prefs.hiddenSessionIds).toEqual([]);
  });

  it("does not highlight or open a session just by focusing an empty search", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={onSelect}
      />,
    );
    const search = screen.getByRole("searchbox", { name: "Search sessions" });
    const highlighted = () =>
      document.querySelector(".nav__row--highlighted .nav__row-name")
        ?.textContent;
    await user.click(search);
    expect(highlighted()).toBeUndefined();
    expect(
      document.getElementById(search.getAttribute("aria-describedby")!),
    ).toBeEmptyDOMElement();
    await user.keyboard("{Enter}");
    expect(onSelect).not.toHaveBeenCalled();
    expect(store.getState().sessionId).toBe("alpha");

    // Empty search still supports deliberate keyboard navigation.
    await user.keyboard("{ArrowDown}");
    expect(highlighted()).toBe("Beta session");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(highlighted()).toBe("Alpha session");
    expect(onSelect).toHaveBeenLastCalledWith("alpha");
    await user.tab();
    await user.click(search);
    expect(highlighted()).toBeUndefined();
    await user.keyboard("{ArrowUp}");
    expect(highlighted()).toBe("Beta session");

    await user.type(search, "session");
    await screen.findByRole("button", { name: /^Beta session/ });
    expect(highlighted()).toBe("Beta session");
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(highlighted()).toBeUndefined();
    await screen.findByRole("button", { name: /^Alpha session/ });
    expect(highlighted()).toBeUndefined();
    onSelect.mockClear();
    await user.keyboard("{Enter}");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects search results in visual order, retaining session identity across pages and curation", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={onSelect}
      />,
    );
    const search = screen.getByRole("searchbox", { name: "Search sessions" });
    extraSessions = [gamma];
    searchPageSize = 2;
    await user.click(search);
    await user.type(search, "session");
    await screen.findByRole("button", { name: /^Beta session/ });
    await user.keyboard("{ArrowDown}");
    expect(
      screen
        .getByRole("button", { name: /^Alpha session/ })
        .closest(".nav__row"),
    ).toHaveClass("nav__row--highlighted");
    expect(search).toHaveFocus();
    expect(store.getState().sessionListNextOffset).toBe(2);
    expect(screen.queryByText("Gamma session")).not.toBeInTheDocument();
    await store.loadOlderSessions();
    await screen.findByRole("button", { name: /^Gamma session/ });
    expect(store.getState().sessionListNextOffset).toBe(3);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("alpha");
    await user.click(
      screen.getByRole("button", { name: 'Pin "Alpha session"' }),
    );
    await user.click(search);
    expect(
      screen
        .getByRole("button", { name: /^Alpha session/ })
        .closest(".nav__row"),
    ).toHaveClass("nav__row--highlighted");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("beta");
    await user.keyboard("{ArrowUp}");
    await user.click(
      screen.getByRole("button", { name: 'Hide "Alpha session"' }),
    );
    await user.click(search);
    const hidden = document.querySelector(".nav__group--hidden") as HTMLElement;
    expect(
      within(hidden)
        .getByRole("button", { name: /^Alpha session/ })
        .closest(".nav__row"),
    ).toHaveClass("nav__row--highlighted");
    await user.keyboard("{ArrowUp}{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("gamma");

    fireEvent.change(search, { target: { value: "beta" } });
    onSelect.mockClear();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    await screen.findByRole("button", { name: /^Beta session/ });
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("beta");
  });

  it("leaves composition and modified editing keys to the search input, while Escape clears before blurring", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={onSelect}
      />,
    );
    const search = screen.getByRole("searchbox", { name: "Search sessions" });
    await user.click(search);
    await user.type(search, "session");
    await screen.findByRole("button", { name: /^Beta session/ });
    const highlighted = () =>
      document.querySelector(".nav__row--highlighted .nav__row-name")
        ?.textContent;
    expect(highlighted()).toBe("Beta session");
    fireEvent.compositionStart(search);
    for (const key of ["ArrowDown", "Enter", "Escape"])
      fireEvent.keyDown(search, { key });
    fireEvent.compositionEnd(search);
    fireEvent.keyDown(search, { key: "ArrowDown", isComposing: true });
    fireEvent.keyDown(search, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(search, { key: "ArrowDown", shiftKey: true });
    expect(highlighted()).toBe("Beta session");
    expect(onSelect).not.toHaveBeenCalled();
    expect(search).toHaveValue("session");
    expect(search).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(search).not.toHaveFocus();
  });

  it("reaches both row actions with the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={() => undefined}
      />,
    );

    screen.getByRole("searchbox", { name: "Search sessions" }).focus();
    await user.tab(); // the newest folder's toggle
    await user.tab(); // its pin
    await user.tab(); // its hide action
    await user.tab(); // its first session row
    expect(document.activeElement).toHaveClass("nav__row-main");
    await user.tab();
    expect(document.activeElement).toHaveAttribute(
      "aria-label",
      'Pin "Beta session"',
    );
    await user.tab();
    expect(document.activeElement).toHaveAttribute(
      "aria-label",
      'Hide "Beta session"',
    );
  });

  it("decorates workspace rows by exact path without basename guessing", async () => {
    render(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={() => undefined}
      />,
    );
    const explorer = document.querySelector(".explorer") as HTMLElement;
    fireEvent.click(
      explorer.querySelector(".explorer__header") as HTMLButtonElement,
    );
    expect(
      within(explorer).getByRole("button", { name: "alpha" }),
    ).toHaveAttribute("title", "/work/alpha");
    expect(
      explorer.querySelector(".explorer__project"),
    ).not.toBeInTheDocument();
    expect(within(explorer).queryByRole("searchbox")).not.toBeInTheDocument();
    const rootFile = await screen.findByRole("button", { name: "changed.ts" });
    expect(
      within(rootFile).queryByLabelText(/unstaged/),
    ).not.toBeInTheDocument();
    expect(rootFile.querySelector(".workspace-tree__name")).not.toHaveClass(
      "git-deco--modified",
    );
    const dirtyDirectory = screen.getByRole("button", {
      name: /other.*contains modified files/i,
    });
    expect(dirtyDirectory.querySelector(".workspace-tree__name")).toHaveClass(
      "git-deco--modified",
    );
    expect(
      within(dirtyDirectory).getByLabelText("Contains modified files"),
    ).toHaveClass("git-rollup", "git-deco--modified");
    fireEvent.click(dirtyDirectory);
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /changed\.ts/ }),
      ).toHaveLength(2),
    );
    const files = screen.getAllByRole("button", { name: /changed\.ts/ });
    const nested = files.find((button) => button !== rootFile)!;
    expect(
      within(nested).getByLabelText("unstaged modified"),
    ).toHaveTextContent("M");
    expect(within(nested).getByLabelText("unstaged modified")).toHaveClass(
      "git-deco--modified",
    );
    expect(nested.querySelector(".workspace-tree__name")).toHaveClass(
      "git-deco--modified",
    );
  });

  it("curates the visible session without changing what is selected", async () => {
    const onSelect = vi.fn();
    render(
      <Nav
        onToggleNavigation={vi.fn()}
        collapsed={false}
        onNewSession={() => undefined}
        onSelectSession={onSelect}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: 'Hide "Alpha session"' }),
    );
    await screen.findByRole("heading", { name: "Hidden" });
    fireEvent.click(screen.getByRole("button", { name: "Hidden" }));

    // The visible session keeps its selection and its active marking wherever
    // curation files it; hiding is navigation metadata, not a switch.
    const row = screen.getByText("Alpha session").closest(".nav__row");
    expect(row).toHaveClass("nav__row--active");
    expect(document.querySelector(".nav__group--hidden")).toContainElement(
      row as HTMLElement,
    );
    expect(
      screen.getByRole("button", { name: 'Delete "Alpha session"' }),
    ).toBeEnabled();
    expect(store.getState().sessionId).toBe("alpha");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
