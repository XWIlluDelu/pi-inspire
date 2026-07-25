// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPreferences } from "../../shared/contracts";
import { Nav } from "../../src/components/Nav";
import { store } from "../../src/store";
import { activeSnapshot, bootstrapPayload, installFakeWebSocket, installFetch, jsonBody, sessionSummary } from "./helpers";

const alpha = sessionSummary({ id: "alpha", title: "Alpha session", cwd: "/work/alpha", project: "alpha" });
const beta = sessionSummary({ id: "beta", title: "Beta session", cwd: "/work/beta", project: "beta" });

describe("session navigation controls", () => {
  beforeEach(async () => {
    installFakeWebSocket();
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap")) {
        return { body: bootstrapPayload({ snapshot: activeSnapshot({ sessionId: "selected" }) }) };
      }
      if (url.startsWith("/api/sessions/pin")) {
        const body = jsonBody(init);
        return {
          body: {
            ...defaultPreferences,
            pinnedSessionIds: body.pinned ? [String(body.id)] : [],
            navCollapsedGroups: store.getState().prefs.navCollapsedGroups,
          },
        };
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
    render(
      <Nav collapsed={false} onNewSession={() => undefined} onSelectSession={onSelect} />,
    );

    const alphaGroup = screen.getByRole("button", { name: "alpha" });
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
    const pin = screen.getByRole("button", { name: 'Pin "Alpha session"' });
    fireEvent.click(pin);

    await screen.findByRole("heading", { name: "Pinned" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: 'Unpin "Alpha session"' })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("alpha", { selector: ".nav__row-project" })).toBeInTheDocument();
  });
});
