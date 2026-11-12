// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiUpdateCheckResponse } from "../../shared/contracts";
import { Notices } from "../../src/components/Notices";
import { SystemVersionsCard } from "../../src/components/SystemVersionsCard";
import { store } from "../../src/store";
import { sessionPage } from "./fixtures/session-catalog";
import {
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  installLocalStorage,
  type RouteHandler,
  type RouteResponse,
} from "./helpers";

const piAvailable: PiUpdateCheckResponse = {
  currentVersion: "1.3.0",
  installedVersion: "1.4.0",
  pi: {
    kind: "available",
    latestVersion: "1.5.0",
    releaseUrl: "https://pi.dev/changelog",
  },
  extensions: { kind: "none" },
};

const extensionUpdates: PiUpdateCheckResponse = {
  currentVersion: "1.3.0",
  installedVersion: "1.3.0",
  pi: { kind: "current", latestVersion: "1.3.0" },
  extensions: {
    kind: "available",
    updates: [
      { displayName: "github.com/example/pi-tools", type: "git" },
      { displayName: "@example/pi-tools", type: "npm" },
    ],
  },
};

describe("System versions", () => {
  beforeEach(() => {
    installLocalStorage();
    installFakeWebSocket();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function initialize(
    piUpdateCheck: PiUpdateCheckResponse,
    updateRoute?: RouteHandler,
  ) {
    const bootstrap = bootstrapPayload({
      piVersion: piUpdateCheck.currentVersion,
    });
    const updateStatus = {
      ...bootstrap.updateStatus,
      piUpdateCheck,
      inspireUpdateCheck: { kind: "unreleased" },
    };
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return { body: { ...bootstrap, updateStatus } };
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      return updateRoute?.(url, init);
    });
    await store.init();
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

  it("keeps previous results copyable during a check and explains failed refreshes", async () => {
    const denied = deferred<RouteResponse>();
    await initialize(piAvailable, (url) =>
      url.endsWith("update?refresh=1") ? denied.promise : undefined,
    );
    render(<SystemVersionsCard />);
    const check = screen.getByRole("button", { name: "Check for updates" });
    const copy = screen.getByRole("button", { name: "Copy update details" });
    const update = screen.getByRole("link", { name: "v1.5.0 available ↗" });
    fireEvent.click(check);
    expect(check).toBeDisabled();
    expect(copy).toBeEnabled();
    expect(update).toBeVisible();

    denied.resolve({ status: 403, body: { error: "Forbidden" } });
    const message = "Couldn't check for updates. Showing previous results.";
    expect(await screen.findByText(message)).toHaveRole("alert");
    expect(check).toHaveAccessibleDescription(message);
    expect(check).toBeEnabled();
    expect(copy).toBeEnabled();
    expect(update).toBeVisible();
  });

  it("links extension packages and lets each copy action recover from a denied clipboard", async () => {
    await initialize(extensionUpdates);
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("Clipboard denied"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Clipboard denied"))
      .mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<SystemVersionsCard />);
    expect(screen.getByText("No release published")).toBeVisible();
    expect(screen.getByText("2 package updates")).toBeVisible();
    const packages = within(
      screen.getByRole("list", { name: "Packages with updates" }),
    );
    expect(
      packages.getByRole("link", { name: "@example/pi-tools" }),
    ).toHaveAttribute(
      "href",
      "https://www.npmjs.com/package/@example/pi-tools",
    );
    expect(
      packages.getByRole("link", { name: "github.com/example/pi-tools" }),
    ).toHaveAttribute("href", "https://github.com/example/pi-tools");

    const copyReport = screen.getByRole("button", {
      name: "Copy update details",
    });
    fireEvent.click(copyReport);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Clipboard denied",
    );
    expect(copyReport).toHaveAccessibleName("Copy update details");

    fireEvent.click(copyReport);
    expect(
      await screen.findByRole("button", { name: "Update details copied" }),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();

    const command = within(
      screen.getByRole("button", { name: "Copy pi update --extensions" }),
    );
    fireEvent.click(command.getByText("pi update --extensions"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Clipboard denied",
    );
    expect(command.queryByText("Copied")).toBeNull();
    fireEvent.click(command.getByText("pi update --extensions"));
    expect(await command.findByText("Copied")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    const report =
      "Extensions\n- @example/pi-tools\n- github.com/example/pi-tools\nRun pi update --extensions";
    expect(writeText.mock.calls).toEqual([
      [report],
      [report],
      ["pi update --extensions"],
      ["pi update --extensions"],
    ]);
  });
});
