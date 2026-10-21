// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { store } from "../../src/store";

afterEach(() => vi.restoreAllMocks());

describe("portable Host recovery guidance", () => {
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
