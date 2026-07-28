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

describe("session navigation controls", () => {
  beforeEach(async () => {
    installFakeWebSocket();
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return { body: bootstrapPayload({ snapshot: activeSnapshot({ sessionId: "alpha", cwd: "/work/alpha" }) }) };
      }
      if (url.startsWith("/api/sessions/by-id")) return { body: { sessions: [] } };
      if (url.startsWith("/api/sessions")) {
        return { body: { sessions: [alpha, beta], total: 2, offset: 0, limit: 40 } };
      }
      if (url.startsWith("/api/preferences") && init.method === "PATCH") return { body: jsonBody(init) };
      return undefined;
    });
    await store.init("token");
    await waitFor(() => expect(store.getState().sessions).toHaveLength(2));
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
    expect(alphaGroup).toHaveAttribute("aria-expanded", "true");
    expect(alphaGroup).toBeDisabled();
    expect(screen.getByText("Alpha session")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search sessions" }), { target: { value: "" } });
    expect(alphaGroup).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(alphaGroup);
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
    const hiddenSection = document.querySelector(".nav__group--hidden") as HTMLElement;
    expect(within(hiddenSection).getByText("Alpha session")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search sessions" }), { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
    fireEvent.click(screen.getByRole("button", { name: 'Unhide "Alpha session"' }));
    await waitFor(() => expect(groupNames()).toEqual(["beta", "alpha"]));
    expect(store.getState().prefs.hiddenSessionIds).toEqual([]);
  });

  it("pins a session out of Hidden, and pins a folder above the ordinary ones", async () => {
    render(<Nav collapsed={false} onNewSession={() => undefined} onSelectSession={() => undefined} />);

    // Newest folder first by default.
    expect(groupNames()).toEqual(["beta", "alpha"]);
    fireEvent.click(screen.getByRole("button", { name: "Pin folder alpha" }));
    await waitFor(() => expect(groupNames()).toEqual(["alpha", "beta"]));

    fireEvent.click(screen.getByRole("button", { name: 'Hide "Beta session"' }));
    await screen.findByRole("heading", { name: "Hidden" });
    fireEvent.click(screen.getByRole("button", { name: "Hidden" }));
    // Pinning a hidden session lifts it out of Hidden in one action.
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
    await user.tab(); // its first session row
    expect(document.activeElement).toHaveClass("nav__row-main");
    await user.tab();
    expect(document.activeElement).toHaveAttribute("aria-label", 'Pin "Beta session"');
    await user.tab();
    expect(document.activeElement).toHaveAttribute("aria-label", 'Hide "Beta session"');
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
    expect(store.getState().sessionId).toBe("alpha");
    expect(onSelect).not.toHaveBeenCalled();
  });
});
