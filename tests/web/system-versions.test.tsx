// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { PiUpdateCheckResponse } from "../../shared/contracts";
import { Notices } from "../../src/components/Notices";
import { SystemVersionsCard } from "../../src/components/SystemVersionsCard";
import { store } from "../../src/store";
import {
  availableUpdates,
  updateDetailsText,
} from "../../src/update-availability";
import { sessionPage } from "./fixtures/session-catalog";
import {
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  installLocalStorage,
} from "./helpers";

describe("System installation and loaded-version status", () => {
  beforeEach(() => {
    installLocalStorage();
    installFakeWebSocket();
  });

  async function initialize(piUpdateCheck: PiUpdateCheckResponse) {
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            piVersion: "1.3.0",
            updateStatus: {
              ...bootstrapPayload().updateStatus,
              piUpdateCheck,
              inspireUpdateCheck: { kind: "unreleased" },
            },
          }),
        };
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      return undefined;
    });
    await store.init("token");
    FakeWebSocket.instances.at(-1)!.open();
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
      "Installed Pi version; Host loaded v1.3.0.",
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
    expect(screen.getByText("v1.4.0")).not.toHaveAttribute("title");
  });

  it("offers a still-newer update from the installed version while a Host restart is pending", async () => {
    await initialize({
      currentVersion: "1.3.0",
      installedVersion: "1.4.0",
      pi: {
        kind: "available",
        latestVersion: "1.5.0",
        releaseUrl: "https://pi.dev/changelog",
      },
      extensions: { kind: "none" },
    });
    render(<SystemVersionsCard />);
    expect(screen.getByText("v1.4.0")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "v1.5.0 available ↗" }),
    ).toBeVisible();
    expect(screen.getByText("Restart Host to apply")).toBeVisible();
    expect(updateDetailsText(availableUpdates(store.getState())!)).toBe(
      "Pi 1.4.0 → 1.5.0\nRun pi update\nhttps://pi.dev/changelog",
    );
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
    expect(screen.queryByText("v1.3.0")).toBeNull();
    expect(screen.queryByText("Restart Host to apply")).toBeNull();
  });
});
