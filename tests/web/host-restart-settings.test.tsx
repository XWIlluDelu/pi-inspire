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
    expect(fixture.start).toHaveBeenCalledWith("all", "fixture-host", false);
  });
  it.each([
    ["host", "active-work"],
    ["all", "in-flight-operation"],
  ] as const)(
    "offers one explicit work-interruption confirmation for a busy %s attempt",
    (scope, busyReason) => {
      fixture.state.status = {
        hostId: "fixture-host",
        available: true,
        operation: {
          id: "safe-attempt",
          scope,
          phase: "rejected",
          busyReason,
          error: "Finish Pi work and pending operations before restarting.",
        },
      };
      render(<HostRestartSettings />);
      expect(screen.getByRole("alert").textContent).toContain(
        "Last restart attempt:",
      );
      const label = `Stop work and restart ${scope === "all" ? "all" : "Host"}`;
      fireEvent.click(screen.getByRole("button", { name: label }));
      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain("stop all active Pi work");
      expect(dialog.textContent).toContain("discard Pending messages");
      expect(dialog.textContent).toContain(
        scope === "all"
          ? "end all project terminal processes"
          : "Project terminals keep running",
      );
      fireEvent.click(dialog.querySelector("button")!);
      expect(fixture.start).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: label }));
      fireEvent.click(
        screen.getByRole("alertdialog").querySelector(".button--danger")!,
      );
      expect(fixture.start).toHaveBeenCalledWith(scope, "fixture-host", true);
    },
  );

  it.each([undefined, "restart-pending"] as const)(
    "does not offer work interruption for a non-work rejection (%s)",
    (busyReason) => {
      fixture.state.status = {
        hostId: "fixture-host",
        available: true,
        operation: {
          id: "rejected-preparation",
          scope: "host",
          phase: "rejected",
          busyReason,
          error: "Restart unavailable",
        },
      };
      render(<HostRestartSettings />);
      expect(
        screen.queryByRole("button", { name: /Stop work and restart/ }),
      ).toBeNull();
      expect(screen.getByRole("alert").textContent).toBe(
        "Last restart attempt: Restart unavailable",
      );
    },
  );

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
