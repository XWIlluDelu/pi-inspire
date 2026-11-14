// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostUpdateStatus,
  PiUpdateCheckResponse,
} from "../../shared/contracts";
import { Notices } from "../../src/components/Notices";
import { SystemVersionsCard } from "../../src/components/SystemVersionsCard";
import { store } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
import {
  bootstrapPayload,
  emptySnapshot,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  installLocalStorage,
} from "./helpers";

describe("System versions", () => {
  beforeEach(() => {
    installLocalStorage();
    installFakeWebSocket();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function initialize(piUpdateCheck: PiUpdateCheckResponse) {
    const bootstrap = bootstrapPayload({
      piVersion: piUpdateCheck.currentVersion,
    });
    const updateStatus: HostUpdateStatus = {
      ...bootstrap.updateStatus,
      piUpdateCheck,
      inspireUpdateCheck: { kind: "unreleased" },
    };
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap"))
        return { body: { ...bootstrap, updateStatus } };
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      return undefined;
    });
    await store.init();
    FakeWebSocket.instances.at(-1)!.join(emptySnapshot, { updateStatus });
  }

  it("replaces update actions and the notice with one restart status, then clears it for a new Host", async () => {
    await initialize({
      currentVersion: "1.3.0",
      installedVersion: "1.4.0",
      pi: { kind: "current", latestVersion: "1.4.0" },
      extensions: { kind: "none" },
    });
    render(
      <>
        <SystemVersionsCard />
        <Notices onViewUpdates={() => undefined} />
      </>,
    );
    expect(screen.getByText("v1.4.0")).toHaveAttribute(
      "title",
      "The Host is running Pi v1.3.0.",
    );
    expect(screen.getByText("Restart Host to apply")).toBeVisible();
    expect(screen.getByText("No updates")).toBeVisible();
    expect(screen.queryByText("Updates available")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy pi update" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy update details" }),
    ).toBeNull();

    await act(async () => {
      await initialize({
        currentVersion: "1.4.0",
        installedVersion: "1.4.0",
        pi: { kind: "current", latestVersion: "1.4.0" },
        extensions: { kind: "none" },
      });
    });
    expect(screen.queryByText("Restart Host to apply")).toBeNull();
    expect(screen.getByText("Up to date")).toBeVisible();
  });

  it("does not present the startup version as the installed version after a failed local read", async () => {
    await initialize({
      currentVersion: "1.3.0",
      installedVersion: null,
      pi: { kind: "unavailable" },
      extensions: { kind: "none" },
    });
    render(<SystemVersionsCard />);
    expect(screen.getByText("Version unavailable")).toBeVisible();
    expect(screen.getByText("Check unavailable")).toBeVisible();
    expect(screen.queryByText("v1.3.0")).toBeNull();
    expect(screen.queryByText("Restart Host to apply")).toBeNull();
  });
});
