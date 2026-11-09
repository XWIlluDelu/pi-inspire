// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRestartSettings } from "../../src/components/HostRestartSettings";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  start: vi.fn(async () => {}),
  clearRecovery: vi.fn(async () => {}),
}));
vi.mock("../../src/controllers/host-restart-controller", () => ({
  hostRestartClient: {
    subscribe: () => () => {},
    snapshot: () => fixture.state,
    refresh: async () => {},
    start: fixture.start,
    clearRecovery: fixture.clearRecovery,
  },
}));
beforeEach(() => {
  fixture.state = {
    status: {
      hostId: "fixture-host",
      available: true,
      allAvailable: true,
      operation: null,
    },
    pending: null,
    sending: false,
    blocked: false,
    recoveryInvalid: false,
    error: null,
    notice: null,
  };
  fixture.start.mockClear();
  fixture.clearRecovery.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("Settings restart controls", () => {
  it("shows two restart choices and keeps their initial availability quiet", () => {
    const ready = fixture.state.status;
    fixture.state.status = null;
    const { container, rerender } = render(<HostRestartSettings />);
    const restart = screen.getByRole("button", { name: "Restart Host" });
    expect(restart).toBeDisabled();
    expect(restart).not.toHaveAttribute("aria-busy", "true");
    const restartAll = screen.getByRole("button", { name: "Restart all" });
    expect(screen.getAllByRole("button")).toEqual([restart, restartAll]);
    expect(restartAll).toBeDisabled();
    expect(restartAll).not.toHaveAttribute("aria-busy", "true");
    expect(container.querySelector(".pi-loading")).toBeNull();
    expect(container.querySelector(".host-restart__status-row")).toBeNull();
    fixture.state.status = ready;
    rerender(<HostRestartSettings />);
    expect(restart).toBeEnabled();
    expect(restartAll).toBeEnabled();
    expect(fixture.start).not.toHaveBeenCalled();
  });

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
      "This Host's project terminals will close.",
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Restart all" }).at(-1)!,
    );
    expect(fixture.start).toHaveBeenCalledWith("all", "fixture-host", false);
  });
  it("suspends a portaled confirmation without restarting or losing the selected scope", () => {
    const { rerender } = render(<HostRestartSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Restart all" }));
    expect(screen.getByRole("alertdialog")).toBeVisible();
    rerender(<HostRestartSettings suspended />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fixture.start).not.toHaveBeenCalled();
    rerender(<HostRestartSettings />);
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
      "Restart all?",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fixture.start).not.toHaveBeenCalled();
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
        allAvailable: true,
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
      expect(dialog.textContent).toContain("Stop active Pi work in Inspire");
      expect(dialog.textContent).toContain("discard Pending messages");
      expect(dialog.textContent).toContain(
        scope === "all"
          ? "This Host's project terminals will close."
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
        allAvailable: true,
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
      allAvailable: true,
      operation: { id: "fixture-op", scope: "all", phase: "preparing" },
    };
    fixture.state.notice = "Host reconnected.";
    render(<HostRestartSettings />);
    expect(screen.getByRole("status").textContent).toBe("Preparing restart…");
    expect(screen.getByRole("button", { name: "Restart Host" })).toBeDisabled();
    expect(screen.queryByText("Host reconnected.")).toBeNull();
  });
  it("keeps ordinary restart enabled and explains unsupported full restart", () => {
    fixture.state.status = {
      hostId: "fixture-host",
      available: true,
      allAvailable: false,
      allReason: "Restart all requires installed Linux systemd services.",
      operation: null,
    };
    render(<HostRestartSettings />);
    expect(screen.getByRole("button", { name: "Restart Host" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restart all" })).toBeDisabled();
    expect(
      screen.getByText(
        "Restart all requires installed Linux systemd services.",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Restart Host" }));
    fireEvent.click(
      screen.getByRole("alertdialog").querySelector(".button--danger")!,
    );
    expect(fixture.start).toHaveBeenCalledWith("host", "fixture-host", false);
  });

  it.each(["preparing", "submitted", "unconfirmed"])(
    "does not expose local-record cleanup during a %s restart",
    (phase) => {
      fixture.state.pending = {
        hostId: "fixture-host",
        operationId: "tracked-request",
        scope: "host",
      };
      fixture.state.status = {
        hostId: "fixture-host",
        available: true,
        allAvailable: true,
        operation:
          phase === "unconfirmed"
            ? null
            : { id: "tracked-request", scope: "host", phase },
      };
      render(<HostRestartSettings />);
      expect(
        screen.queryByRole("button", {
          name: /Clear local|Reset restart recovery/,
        }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Recheck status" }),
      ).toBeEnabled();
      expect(
        screen.getByRole("button", { name: "Restart Host" }),
      ).toBeDisabled();
    },
  );

  it("lets transient storage failures recover without offering a reset", () => {
    fixture.state.blocked = true;
    fixture.state.error = "Browser recovery storage is unavailable";
    render(<HostRestartSettings />);
    expect(
      screen.queryByRole("button", { name: "Reset restart recovery…" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Recheck status" }),
    ).toBeEnabled();
  });

  it("offers confirmed repair only beside an invalid-record error and keeps the Host restart fenced", () => {
    fixture.state.blocked = true;
    fixture.state.recoveryInvalid = true;
    fixture.state.error = "Browser restart recovery is unreadable";
    fixture.state.status = {
      hostId: "fixture-host",
      available: true,
      allAvailable: true,
      operation: { id: "already-sent", scope: "host", phase: "submitted" },
    };
    const confirm = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    render(<HostRestartSettings />);
    const clear = screen.getByRole("button", {
      name: "Reset restart recovery…",
    });
    expect(clear.closest(".host-restart__status-copy")).not.toBeNull();
    fireEvent.click(clear);
    expect(fixture.clearRecovery).not.toHaveBeenCalled();
    fireEvent.click(clear);
    expect(fixture.clearRecovery).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Any restart already requested can still run."),
    );
    expect(fixture.start).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restart Host" })).toBeDisabled();
  });

  it("blocks controls when service ownership is unavailable", () => {
    fixture.state.status = {
      hostId: "fixture-host",
      available: false,
      allAvailable: false,
      reason: "Installed service required.",
    };
    render(<HostRestartSettings />);
    expect(screen.getByRole("button", { name: "Restart all" })).toBeDisabled();
    expect(screen.getByText("Installed service required.")).toBeVisible();
  });
});
