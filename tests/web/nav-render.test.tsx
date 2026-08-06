// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Nav } from "../../src/components/Nav";
import { store } from "../../src/store";
import { activeSnapshot, bootstrapPayload, installFakeWebSocket, installFetch, jsonBody, sessionSummary } from "./helpers";

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

const groupNames = () =>
  [...document.querySelectorAll(".nav__group-name")].map((node) => node.textContent);
/** The session list only: the workspace explorer below it names the visible
 * session's folder too. */
const list = () => within(document.querySelector(".nav__list") as HTMLElement);

let deletedSessions: Set<string>;

describe("session navigation controls", () => {
  beforeEach(async () => {
    deletedSessions = new Set();
    installFakeWebSocket();
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return { body: bootstrapPayload({ snapshot: activeSnapshot({ sessionId: "alpha", cwd: "/work/alpha" }) }) };
      }
      if (url.startsWith("/api/git/status")) return { body: {
        kind: "repository",
        head: { kind: "branch", name: "main", oid: "0123456789abcdef" },
        files: [{
          path: { id: "b3RoZXIvY2hhbmdlZC50cw", display: "other/changed.ts", utf8Path: "other/changed.ts", workspacePath: "other/changed.ts" },
          unstaged: { kind: "modified" }, untracked: false,
        }],
        total: 1,
        truncated: false,
        groups: { conflicted: [], staged: [], unstaged: ["b3RoZXIvY2hhbmdlZC50cw"], untracked: [] },
      } };
      if (url.startsWith("/api/files/list")) {
        const dir = new URL(url, "http://local").searchParams.get("dir") ?? "";
        return { body: { entries: dir === "other"
          ? [{ name: "changed.ts", type: "file" }]
          : [{ name: "other", type: "dir" }, { name: "changed.ts", type: "file" }] } };
      }
      if (url.startsWith("/api/sessions/by-id")) return { body: { sessions: [] } };
      if (url.startsWith("/api/sessions/") && init.method === "DELETE") {
        const sessionId = decodeURIComponent(url.split("/").at(-1)!);
        deletedSessions.add(sessionId);
        const prefs = store.getState().prefs;
        return { body: {
          sessionId,
          disposition: "trashed",
          preferences: {
            ...prefs,
            pinnedSessionIds: prefs.pinnedSessionIds.filter((id) => id !== sessionId),
            hiddenSessionIds: prefs.hiddenSessionIds.filter((id) => id !== sessionId),
          },
        } };
      }
      if (url.startsWith("/api/sessions")) {
        const query = new URL(url, "http://local").searchParams.get("q")?.toLowerCase() ?? "";
        const sessions = [alpha, beta].filter((session) =>
          !deletedSessions.has(session.id) && session.title.toLowerCase().includes(query),
        );
        return { body: { sessions, total: sessions.length, offset: 0, limit: 40 } };
      }
      if (url.startsWith("/api/preferences") && init.method === "PATCH") return { body: jsonBody(init) };
      return undefined;
    });
    await store.init("token");
    await waitFor(() => expect(store.getState().sessions).toHaveLength(2));
  });

  it("uses one icon-and-wordmark target for brand and new session in both nav widths", () => {
    const onNewSession = vi.fn();
    const { rerender } = render(
      <Nav collapsed={false} newSessionActive onNewSession={onNewSession} onSelectSession={() => undefined} />,
    );
    const brand = screen.getByRole("button", { name: "New session" });
    expect(brand).toHaveAttribute("aria-current", "page");
    expect(brand.querySelector(".nav__brand-icon")).not.toBeNull();
    expect(brand).toHaveTextContent("insπre");
    fireEvent.click(brand);
    expect(onNewSession).toHaveBeenCalledOnce();

    rerender(<Nav collapsed newSessionActive={false} onNewSession={onNewSession} onSelectSession={() => undefined} />);
    const railBrand = screen.getByRole("button", { name: "New session" });
    expect(railBrand.querySelector(".nav__brand-icon--rail")).not.toBeNull();
    expect(railBrand).not.toHaveTextContent("π");
  });

  it("collapses folders, exposes search matches, and pins without selecting", async () => {
    const onSelect = vi.fn();
    render(<Nav collapsed={false} onNewSession={() => undefined} onSelectSession={onSelect} />);

    const alphaGroup = list().getByRole("button", { name: "alpha" });
    expect(alphaGroup).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(alphaGroup);
    expect(alphaGroup).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Alpha session")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search sessions" }), { target: { value: "alpha" } });
    const searchAlphaGroup = await list().findByRole("button", { name: "alpha" });
    expect(searchAlphaGroup).toHaveAttribute("aria-expanded", "true");
    expect(searchAlphaGroup).toBeDisabled();
    expect(screen.getByText("Alpha session")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search sessions" }), { target: { value: "" } });
    const restoredAlphaGroup = await list().findByRole("button", { name: "alpha" });
    expect(restoredAlphaGroup).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(restoredAlphaGroup);
    fireEvent.click(screen.getByRole("button", { name: 'Pin "Alpha session"' }));

    await screen.findByRole("heading", { name: "Pinned" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: 'Unpin "Alpha session"' })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("alpha", { selector: ".nav__row-project" })).toBeInTheDocument();
  });

  it("moves a session into the collapsed Hidden group and takes it back", async () => {
    render(<Nav collapsed={false} onNewSession={() => undefined} onSelectSession={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: 'Hide "Alpha session"' }));
    await screen.findByRole("heading", { name: "Hidden" });
    // Hidden starts closed, and its folder disappears with its last session.
    expect(screen.queryByText("Alpha session")).not.toBeInTheDocument();
    expect(groupNames()).toEqual(["beta", "Hidden"]);

    // Search reveals the match without reclassifying it out of Hidden.
    fireEvent.change(screen.getByRole("searchbox", { name: "Search sessions" }), { target: { value: "alpha" } });
    await screen.findByRole("heading", { name: "Hidden" });
    const hiddenSection = document.querySelector(".nav__group--hidden") as HTMLElement;
    expect(await within(hiddenSection).findByText("Alpha session")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search sessions" }), { target: { value: "" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Hidden" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
    fireEvent.click(screen.getByRole("button", { name: 'Restore "Alpha session"' }));
    await waitFor(() => expect(groupNames()).toEqual(["beta", "alpha"]));
    expect(store.getState().prefs.hiddenSessionIds).toEqual([]);
  });

  it("hides and restores a folder without rewriting its sessions' own curation", async () => {
    render(<Nav collapsed={false} onNewSession={() => undefined} onSelectSession={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide folder alpha" }));
    await screen.findByRole("heading", { name: "Hidden" });
    expect(screen.queryByText("Alpha session")).not.toBeInTheDocument();
    expect(store.getState().prefs.hiddenProjectCwds).toEqual(["/work/alpha"]);
    expect(store.getState().prefs.hiddenSessionIds).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
    const hiddenSection = document.querySelector(".nav__group--hidden") as HTMLElement;
    const hiddenFolder = within(hiddenSection).getByRole("button", { name: "alpha" });
    expect(hiddenFolder).toHaveAttribute("aria-expanded", "true");
    expect(within(hiddenSection).getByText("Alpha session")).toBeInTheDocument();
    fireEvent.click(within(hiddenSection).getByRole("button", { name: "Restore folder alpha" }));

    await waitFor(() => expect(store.getState().prefs.hiddenProjectCwds).toEqual([]));
    expect(store.getState().prefs.hiddenSessionIds).toEqual([]);
    expect(screen.getByRole("button", { name: "Hide folder alpha" })).toBeInTheDocument();
  });

  it("deletes only through Hidden after an explicit confirmation", async () => {
    render(<Nav collapsed={false} onNewSession={() => undefined} onSelectSession={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: 'Hide "Beta session"' }));
    await screen.findByRole("heading", { name: "Hidden" });
    fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
    expect(screen.queryByRole("button", { name: 'Pin "Beta session"' })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: 'Hide "Beta session"' })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: 'Restore "Beta session"' })).toBeEnabled();

    const deleteButton = screen.getByRole("button", { name: 'Delete "Beta session"' });
    fireEvent.click(deleteButton);
    const dialog = screen.getByRole("alertdialog", { name: "Delete session?" });
    expect(within(dialog).getByText("Beta session")).toBeInTheDocument();
    expect(within(dialog).queryByText("beta")).not.toBeInTheDocument();
    const description = dialog.querySelector("#session-delete-description");
    expect(description).not.toBeNull();
    expect(Array.from(description!.children).map((line) => line.textContent)).toEqual([
      "This session will be moved to Trash.",
      "If Trash is unavailable, it will be permanently deleted.",
      "Forked sessions remain; project files are unchanged.",
    ]);
    expect(within(dialog).getByText(/another Pi process/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog", { name: "Delete session?" })).not.toBeInTheDocument();
    expect(screen.getByText("Beta session")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: 'Delete "Beta session"' }));
    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
    await waitFor(() => expect(screen.queryByText("Beta session")).not.toBeInTheDocument());
    expect(deletedSessions).toEqual(new Set(["beta"]));
    expect(store.getState().notices.at(-1)?.text).toBe("Session moved to Trash");
    expect(store.getState().prefs.hiddenSessionIds).toEqual([]);
  });

  it("restores then pins a session, and pins a folder above the ordinary ones", async () => {
    render(<Nav collapsed={false} onNewSession={() => undefined} onSelectSession={() => undefined} />);

    // Newest folder first by default. Folder controls share the same compact
    // right-hand action tier as session rows.
    expect(groupNames()).toEqual(["beta", "alpha"]);
    const folderPin = screen.getByRole("button", { name: "Pin folder alpha" });
    expect(folderPin.querySelector("svg")).toHaveAttribute("width", "12");
    fireEvent.click(folderPin);
    await waitFor(() => expect(groupNames()).toEqual(["alpha", "beta"]));

    fireEvent.click(screen.getByRole("button", { name: 'Hide "Beta session"' }));
    await screen.findByRole("heading", { name: "Hidden" });
    fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
    // Hidden rows reserve their two action slots for Restore and Delete.
    expect(screen.queryByRole("button", { name: 'Pin "Beta session"' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: 'Restore "Beta session"' }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Hidden" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: 'Pin "Beta session"' }));
    await screen.findByRole("heading", { name: "Pinned" });
    expect(screen.queryByRole("heading", { name: "Hidden" })).not.toBeInTheDocument();
    expect(store.getState().prefs).toMatchObject({ pinnedSessionIds: ["beta"], hiddenSessionIds: [] });
  });

  it("reaches both row actions with the keyboard", async () => {
    const user = userEvent.setup();
    render(<Nav collapsed={false} onNewSession={() => undefined} onSelectSession={() => undefined} />);

    screen.getByRole("searchbox", { name: "Search sessions" }).focus();
    await user.tab(); // the newest folder's toggle
    await user.tab(); // its pin
    await user.tab(); // its hide action
    await user.tab(); // its first session row
    expect(document.activeElement).toHaveClass("nav__row-main");
    await user.tab();
    expect(document.activeElement).toHaveAttribute("aria-label", 'Pin "Beta session"');
    await user.tab();
    expect(document.activeElement).toHaveAttribute("aria-label", 'Hide "Beta session"');
  });

  it("decorates workspace rows by exact path without basename guessing", async () => {
    render(<Nav collapsed={false} onNewSession={() => undefined} onSelectSession={() => undefined} />);
    fireEvent.click(document.querySelector(".explorer__header") as HTMLButtonElement);
    const rootFile = await screen.findByRole("button", { name: "changed.ts" });
    expect(within(rootFile).queryByLabelText(/unstaged/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "other" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /changed\.ts/ })).toHaveLength(2));
    const files = screen.getAllByRole("button", { name: /changed\.ts/ });
    const nested = files.find((button) => button !== rootFile)!;
    expect(within(nested).getByLabelText("unstaged modified")).toHaveTextContent("M");
  });

  it("curates the visible session without changing what is selected", async () => {
    const onSelect = vi.fn();
    render(<Nav collapsed={false} onNewSession={() => undefined} onSelectSession={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: 'Hide "Alpha session"' }));
    await screen.findByRole("heading", { name: "Hidden" });
    fireEvent.click(screen.getByRole("button", { name: "Hidden" }));

    // The visible session keeps its selection and its active marking wherever
    // curation files it; hiding is navigation metadata, not a switch.
    const row = screen.getByText("Alpha session").closest(".nav__row");
    expect(row).toHaveClass("nav__row--active");
    expect(document.querySelector(".nav__group--hidden")).toContainElement(row as HTMLElement);
    expect(screen.getByRole("button", { name: 'Delete "Alpha session"' })).toBeDisabled();
    expect(store.getState().sessionId).toBe("alpha");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
