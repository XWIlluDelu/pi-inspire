// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { store } from "../../src/store";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("portable Host recovery guidance", () => {
  it("keeps a short stream interruption in the topbar and escalates only when it persists", async () => {
    vi.useFakeTimers();
    let state: ReturnType<typeof store.getState> = {
      ...store.getState(),
      needsToken: false,
      bootstrapped: true,
      connection: "reconnecting",
      connectionProblem: { kind: "stream-interrupted" },
    };
    vi.spyOn(store, "getState").mockImplementation(() => state);
    const { rerender, unmount } = render(<App />);
    expect(screen.queryByRole("button", { name: "Retry now" })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByRole("button", { name: "Retry now" })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(screen.getByRole("button", { name: "Retry now" })).toBeVisible();
    state = { ...state, connection: "open", connectionProblem: null };
    rerender(<App />);
    expect(screen.queryByRole("button", { name: "Retry now" })).toBeNull();
    unmount();
  });
  it("names the launcher without requiring a POSIX wrapper when pairing", () => {
    vi.spyOn(store, "getState").mockReturnValue({
      ...store.getState(),
      needsToken: true,
      bootstrapped: false,
    });
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "Pair this browser" }),
    ).toBeVisible();
    expect(
      screen.getByText(/the URL printed by your Inspire launcher/),
    ).toBeVisible();
    expect(screen.queryByText("./inspire")).toBeNull();
  });

  it("offers portable installed-package and source-checkout restart commands", () => {
    vi.spyOn(store, "getState").mockReturnValue({
      ...store.getState(),
      needsToken: false,
      bootstrapped: false,
      connection: "offline",
      connectionProblem: { kind: "address-unreachable" },
    });
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "INSΠRE address not reachable" }),
    ).toBeVisible();
    expect(screen.getByText("inspire restart")).toBeVisible();
    expect(screen.getByText("npm run inspire -- restart")).toBeVisible();
    expect(screen.queryByText("./inspire")).toBeNull();
  });
});
