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
    const status = container.querySelector(".host-restart__status-row");
    expect(status).toHaveTextContent(/^$/);
    fixture.state.status = ready;
    rerender(<HostRestartSettings />);
    expect(container.querySelector(".host-restart__status-row")).toBe(status);
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
    "replaces the busy %s action with a direct stop and restart",
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
      const restart = scope === "all" ? "Restart all" : "Restart Host";
      expect(screen.queryByRole("button", { name: restart })).toBeNull();
      const label = `Stop work and restart ${scope === "all" ? "all" : "Host"}`;
      const stopAndRestart = screen.getByRole("button", { name: label });
      expect(stopAndRestart.closest(".settings__field")).toHaveTextContent(
        restart,
      );
      fireEvent.click(stopAndRestart);
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(fixture.start).toHaveBeenCalledExactlyOnceWith(
        scope,
        "fixture-host",
        true,
      );
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

  it("offers Restart anyway in the affected row after an unconfirmed Stop", () => {
    fixture.state.status = {
      hostId: "fixture-host",
      available: true,
      allAvailable: true,
      operation: {
        id: "unconfirmed-stop",
        scope: "host",
        phase: "rejected",
        stopUnconfirmed: true,
        error:
          "Could not confirm Stop for session A. Work may still be running.",
      },
    };
    render(<HostRestartSettings />);
    expect(screen.getByRole("alert")).toHaveTextContent("session A");
    const button = screen.getByRole("button", { name: "Restart Host anyway" });
    expect(button.closest(".settings__field")).toHaveTextContent(
      "Restart Host",
    );
    fireEvent.click(button);
    expect(fixture.start).toHaveBeenCalledExactlyOnceWith(
      "host",
      "fixture-host",
      true,
      true,
    );
  });

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

  it("shows preparation during a retry before the Host observes it", () => {
    fixture.state.status = {
      hostId: "fixture-host",
      available: true,
      allAvailable: true,
      operation: {
        id: "old-attempt",
        scope: "host",
        phase: "rejected",
        error: "Pi work was active.",
      },
    };
    fixture.state.pending = {
      hostId: "fixture-host",
      operationId: "new-attempt",
      scope: "host",
    };
    fixture.state.sending = true;
    render(<HostRestartSettings />);
    expect(screen.getByRole("status")).toHaveTextContent("Preparing restart…");
    expect(screen.queryByText(/Last restart attempt/)).toBeNull();
    expect(screen.queryByText("Restart request not confirmed.")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Retry same request" }),
    ).toBeNull();
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
