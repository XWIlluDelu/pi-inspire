// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRestartSettings } from "../../src/components/HostRestartSettings";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  start: vi.fn(async () => {}),
}));
vi.mock("../../src/controllers/host-restart-controller", () => ({
  hostRestartClient: {
    subscribe: () => () => {},
    snapshot: () => fixture.state,
    refresh: async () => {},
    start: fixture.start,
  },
}));
beforeEach(() => {
  fixture.state = {
    status: { hostId: "fixture-host", available: true, operation: null },
    pending: null,
    sending: false,
    blocked: false,
    error: null,
    notice: null,
  };
  fixture.start.mockClear();
});
afterEach(cleanup);
describe("Settings restart controls", () => {
  it("uses concise confirmation, cancels without mutation, and binds the selected scope", () => {
    render(<HostRestartSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Restart Host" }));
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "The page will briefly disconnect.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fixture.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restart all" }));
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "end all project terminal processes",
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Restart all" }).at(-1)!,
    );
    expect(fixture.start).toHaveBeenCalledWith("all", "fixture-host");
  });
  it("shows current preparation rather than an old reconnection notice", () => {
    fixture.state.status = {
      hostId: "fixture-host",
      available: true,
      operation: { id: "fixture-op", scope: "all", phase: "preparing" },
    };
    fixture.state.notice = "Host reconnected.";
    render(<HostRestartSettings />);
    expect(screen.getByRole("status").textContent).toBe("Preparing restart…");
    expect(screen.getByRole("button", { name: "Restart Host" })).toBeDisabled();
    expect(screen.queryByText("Host reconnected.")).toBeNull();
  });
  it("blocks controls when service ownership is unavailable", () => {
    fixture.state.status = {
      hostId: "fixture-host",
      available: false,
      reason: "Installed service required.",
    };
    render(<HostRestartSettings />);
    expect(screen.getByRole("button", { name: "Restart all" })).toBeDisabled();
    expect(screen.getByText("Installed service required.")).toBeVisible();
  });
});
