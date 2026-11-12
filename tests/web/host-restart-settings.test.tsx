// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRestartSettings } from "../../src/components/HostRestartSettings";
import type { HostRestartClient } from "../../src/controllers/host-restart-controller";

const fixture = vi.hoisted(() => ({
  state: {} as ReturnType<HostRestartClient["snapshot"]>,
  start: vi.fn(async () => {}),
  retry: vi.fn(async () => {}),
  clearRecovery: vi.fn(async () => {}),
}));
vi.mock("../../src/controllers/host-restart-controller", () => ({
  hostRestartClient: {
    subscribe: () => () => {},
    snapshot: () => fixture.state,
    refresh: async () => {},
    start: fixture.start,
    retry: fixture.retry,
    clearRecovery: fixture.clearRecovery,
  },
}));

const available = {
  hostId: "fixture-host",
  available: true,
  allAvailable: true,
  operation: null,
};

beforeEach(() => {
  fixture.state = {
    status: available,
    pending: null,
    sending: false,
    blocked: false,
    recoveryInvalid: false,
    error: null,
    notice: null,
  };
});
afterEach(() => vi.unstubAllGlobals());

describe("Settings restart controls", () => {
  it("keeps restart controls quiet until Host availability is known", () => {
    fixture.state.status = null;
    const { rerender } = render(<HostRestartSettings />);
    const host = screen.getByRole("button", { name: "Restart Host" });
    const all = screen.getByRole("button", { name: "Restart all" });
    expect(host).toBeDisabled();
    expect(all).toBeDisabled();
    expect(screen.queryByRole("status")).toBeNull();

    fixture.state.status = {
      ...available,
      allAvailable: false,
      allReason: "Restart all requires installed Linux systemd services.",
    };
    rerender(<HostRestartSettings />);
    expect(host).toBeEnabled();
    expect(all).toBeDisabled();
    expect(screen.getByText(fixture.state.status.allReason!)).toBeVisible();

    fixture.state.status = {
      ...fixture.state.status,
      available: false,
      reason: "Installed service required.",
    };
    rerender(<HostRestartSettings />);
    expect(host).toBeDisabled();
    expect(all).toBeDisabled();
    expect(screen.getByText(fixture.state.status.reason!)).toBeVisible();
  });

  it("keeps a portaled confirmation's scope through suspension and lets the user cancel", () => {
    const { rerender } = render(<HostRestartSettings />);
    const restartAll = screen.getByRole("button", { name: "Restart all" });
    fireEvent.click(restartAll);
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "This Host's project terminals will close.",
    );
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

  it("does not offer work interruption when a restart is already pending", () => {
    fixture.state.status = {
      ...available,
      operation: {
        id: "rejected-preparation",
        scope: "host",
        phase: "rejected",
        busyReason: "restart-pending",
        error: "Restart unavailable",
      },
    };
    render(<HostRestartSettings />);
    expect(
      screen.queryByRole("button", { name: /Stop work and restart/ }),
    ).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Last restart attempt: Restart unavailable",
    );
  });

  it("offers Restart anyway after an unconfirmed Stop", () => {
    fixture.state.status = {
      ...available,
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
    fireEvent.click(
      screen.getByRole("button", { name: "Restart Host anyway" }),
    );
    expect(fixture.start).toHaveBeenCalledExactlyOnceWith(
      "host",
      available.hostId,
      true,
      true,
    );
  });

  it("allows retry only until the Host observes the tracked restart", () => {
    const operation = { id: "tracked-request", scope: "host" } as const;
    fixture.state.pending = {
      hostId: available.hostId,
      operationId: operation.id,
      scope: operation.scope,
    };
    fixture.state.notice = "Host reconnected.";
    const { rerender } = render(<HostRestartSettings />);
    const restart = screen.getByRole("button", { name: "Restart Host" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Restart request not confirmed.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry same request" }));
    expect(fixture.retry).toHaveBeenCalledOnce();

    fixture.state.status = {
      ...available,
      operation: { ...operation, phase: "submitted" },
    };
    rerender(<HostRestartSettings />);
    expect(screen.getByRole("status")).toHaveTextContent("Restart requested.");
    expect(
      screen.queryByRole("button", { name: "Retry same request" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Recheck status" }),
    ).toBeEnabled();
    expect(restart).toBeDisabled();
  });

  it("offers a confirmed reset for an unreadable record while fencing an active Host restart", () => {
    fixture.state.blocked = true;
    fixture.state.error = "Browser recovery storage is unavailable";
    fixture.state.status = {
      ...available,
      operation: { id: "already-sent", scope: "host", phase: "submitted" },
    };
    const confirm = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);
    const { rerender } = render(<HostRestartSettings />);
    const resetName = "Reset restart recovery…";
    expect(
      screen.getByRole("button", { name: "Recheck status" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: resetName })).toBeNull();

    fixture.state.recoveryInvalid = true;
    fixture.state.error = "Browser restart recovery is unreadable";
    rerender(<HostRestartSettings />);
    expect(screen.getByRole("alert")).toHaveTextContent(fixture.state.error);
    const reset = screen.getByRole("button", { name: resetName });
    fireEvent.click(reset);
    expect(fixture.clearRecovery).not.toHaveBeenCalled();
    fireEvent.click(reset);
    expect(fixture.clearRecovery).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Any restart already requested can still run."),
    );
    expect(screen.getByRole("button", { name: "Restart Host" })).toBeDisabled();
  });
});
