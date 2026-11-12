// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HerdrEnhancementStatus } from "../../shared/herdr";
import { HerdrSettings } from "../../src/components/HerdrSettings";
import { deferred } from "./helpers";

const fixture = vi.hoisted(() => ({
  saved: false,
  save: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../../src/store", () => ({
  useAppState: (selector: (state: unknown) => unknown) =>
    selector({ prefs: { herdrEnabled: fixture.saved } }),
  store: { setHerdrEnabled: fixture.save },
}));
const ready = {
  enabled: false,
  ready: true,
  supported: true,
  installed: true,
  running: false,
  compatible: true,
  version: "0.9.1",
};
beforeEach(() => {
  fixture.saved = false;
  fixture.save.mockClear();
  fixture.navigate.mockClear();
});
afterEach(cleanup);

describe("Herdr Settings", () => {
  it("can turn off while blocked and review a restart after availability recovers", async () => {
    fixture.saved = true;
    const blocked = {
      ...ready,
      ready: false,
      issue: "Herdr worker scopes are unavailable: user manager unavailable",
    };
    const recheck = deferred<HerdrEnhancementStatus>();
    const getStatus = vi
      .fn<() => Promise<HerdrEnhancementStatus>>()
      .mockResolvedValueOnce(blocked)
      .mockReturnValueOnce(recheck.promise);
    const settings = (
      <HerdrSettings
        getStatus={getStatus}
        onNavigateRestart={fixture.navigate}
      />
    );
    const { rerender } = render(settings);
    const toggle = screen.getByRole("switch", { name: "Herdr enhancement" });
    await screen.findByText(blocked.issue);
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith(false);
    fixture.saved = false;
    rerender(
      <HerdrSettings
        getStatus={getStatus}
        onNavigateRestart={fixture.navigate}
      />,
    );
    expect(toggle).toBeDisabled();

    const retry = screen.getByRole("button", { name: "Recheck availability" });
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText(blocked.issue)).toBeVisible();
    await act(async () => recheck.resolve(ready));
    expect(toggle).toBeEnabled();
    expect(retry).not.toBeInTheDocument();
    expect(screen.queryByText(blocked.issue)).toBeNull();

    fireEvent.click(toggle);
    expect(fixture.save).toHaveBeenLastCalledWith(true);
    fixture.saved = true;
    rerender(
      <HerdrSettings
        getStatus={getStatus}
        onNavigateRestart={fixture.navigate}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Herdr will turn on after restart.",
    );
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(fixture.navigate).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Review Host restart" }),
    );
    expect(fixture.navigate).toHaveBeenCalledOnce();
  });

  it("retires a pending recheck when its status source changes", async () => {
    const blocked = { ...ready, ready: false, issue: "Old Host unavailable" };
    const recheck = deferred<HerdrEnhancementStatus>();
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(blocked)
      .mockReturnValueOnce(recheck.promise);
    const view = render(
      <HerdrSettings
        getStatus={getStatus}
        onNavigateRestart={fixture.navigate}
      />,
    );
    await screen.findByText(blocked.issue);
    fireEvent.click(
      screen.getByRole("button", { name: "Recheck availability" }),
    );
    expect(getStatus).toHaveBeenCalledTimes(2);

    view.rerender(
      <HerdrSettings
        getStatus={async () => ready}
        onNavigateRestart={fixture.navigate}
      />,
    );
    const toggle = screen.getByRole("switch", { name: "Herdr enhancement" });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    await act(async () => recheck.resolve(blocked));
    expect(toggle).not.toBeDisabled();
    expect(screen.queryByText(blocked.issue)).toBeNull();
  });

  it("reports a missing status hook without blocking turning off", async () => {
    fixture.saved = true;
    const getStatus = vi.fn(async () => {
      throw new Error("503");
    });
    render(
      <HerdrSettings
        getStatus={getStatus}
        onNavigateRestart={fixture.navigate}
      />,
    );
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
