// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HerdrSettings } from "../../src/components/HerdrSettings";

const fixture = vi.hoisted(() => ({
  saved: false,
  save: vi.fn(),
}));
vi.mock("../../src/store", () => ({
  useAppState: (selector: (state: unknown) => unknown) =>
    selector({ prefs: { herdrEnabled: fixture.saved } }),
  store: { setHerdrEnabled: fixture.save },
}));
const ready = {
  enabled: false,
  supported: true,
  installed: true,
  running: false,
  compatible: true,
  version: "0.9.1",
};
beforeEach(() => {
  fixture.saved = false;
  fixture.save.mockClear();
});
afterEach(cleanup);

describe("Herdr Settings", () => {
  it("enables a supported installation and explains the pending Host restart without issuing one", async () => {
    const getStatus = vi.fn(async () => ready);
    const { rerender } = render(<HerdrSettings getStatus={getStatus} />);
    const toggle = screen.getByRole("switch", { name: "Herdr enhancement" });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    expect(fixture.save).toHaveBeenCalledWith(true);
    fixture.saved = true;
    rerender(<HerdrSettings getStatus={getStatus} />);
    expect(screen.getByRole("status").textContent).toMatch(
      /Restart Host to turn on/,
    );
    expect(
      screen
        .getByRole("link", { name: "Review Host restart" })
        .getAttribute("href"),
    ).toBe("#settings-host-restart");
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it("explains an unavailable backend and still allows disabling a saved choice", async () => {
    const getStatus = vi.fn(async () => ({
      ...ready,
      supported: false,
      installed: false,
      issue: "Herdr is unavailable on this platform.",
    }));
    const { rerender } = render(<HerdrSettings getStatus={getStatus} />);
    const toggle = screen.getByRole("switch", { name: "Herdr enhancement" });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Herdr is unavailable on this platform.",
      ),
    );
    expect(toggle).toBeDisabled();
    fixture.saved = true;
    rerender(<HerdrSettings getStatus={getStatus} />);
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    expect(fixture.save).toHaveBeenCalledWith(false);
  });

  it("reports a missing status hook without blocking turning off", async () => {
    fixture.saved = true;
    const getStatus = vi.fn(async () => {
      throw new Error("503");
    });
    render(<HerdrSettings getStatus={getStatus} />);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "status is unavailable",
      ),
    );
    const toggle = screen.getByRole("switch", { name: "Herdr enhancement" });
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    expect(fixture.save).toHaveBeenCalledWith(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Recheck availability" }),
    );
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
  });
});
