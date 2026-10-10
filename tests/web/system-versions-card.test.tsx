// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "../../src/app-state";
import { SystemVersionsCard } from "../../src/components/SystemVersionsCard";

type VersionState = Pick<
  AppState,
  | "piUpdateCheck"
  | "piUpdateChecking"
  | "piUpdateRequestPending"
  | "piVersion"
  | "inspireUpdateCheck"
  | "inspireUpdateChecking"
  | "inspireUpdateRequestPending"
  | "version"
>;

const fixture = vi.hoisted(() => ({
  state: {} as VersionState,
  checkPiUpdate: vi.fn(),
  checkInspireUpdate: vi.fn(),
}));
vi.mock("../../src/store", () => ({
  useAppState: (selector: (state: VersionState) => unknown) =>
    selector(fixture.state),
  shallowEqual: Object.is,
  store: {
    checkPiUpdate: fixture.checkPiUpdate,
    checkInspireUpdate: fixture.checkInspireUpdate,
  },
}));

beforeEach(() => {
  fixture.state = {
    piUpdateCheck: null,
    piUpdateChecking: false,
    piUpdateRequestPending: false,
    piVersion: "1.0.0",
    inspireUpdateCheck: null,
    inspireUpdateChecking: false,
    inspireUpdateRequestPending: false,
    version: "0.4.0",
  };
});
afterEach(() => vi.unstubAllGlobals());

function availableUpdates() {
  fixture.state.piUpdateCheck = {
    currentVersion: "1.0.0",
    pi: {
      kind: "available",
      latestVersion: "1.1.0",
      releaseUrl: "https://pi.dev/changelog",
    },
    extensions: {
      kind: "available",
      updates: [
        { displayName: "@example/pi-tools", type: "npm" },
        { displayName: "github.com/example/pi-tools", type: "git" },
      ],
    },
  };
  fixture.state.inspireUpdateCheck = {
    kind: "available",
    update: {
      currentVersion: "0.4.0",
      latestVersion: "0.5.0",
      releaseUrl: "https://example.com/inspire/release",
    },
  };
}

function row(label: string) {
  const term = screen
    .getAllByRole("term")
    .find((element) => element.firstElementChild?.textContent === label)!;
  return within(term.parentElement!);
}

describe("System versions", () => {
  it("orders Pi, Extensions, Inspire and keeps Pi references beside its label", () => {
    render(<SystemVersionsCard />);
    expect(
      screen
        .getAllByRole("term")
        .map((term) => term.firstElementChild?.textContent),
    ).toEqual(["Pi", "Extensions", "INSΠRE"]);
    const docs = screen.getByRole("link", { name: "Pi docs" });
    const changelog = screen.getByRole("link", { name: "Changelog" });
    expect(docs.closest("dt")).toBe(changelog.closest("dt"));
    expect(docs.closest("dt")?.firstElementChild?.textContent).toBe("Pi");
    expect(docs).toHaveAttribute(
      "href",
      "https://github.com/earendil-works/pi",
    );
    expect(changelog).toHaveAttribute(
      "href",
      "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md",
    );
    expect(row("Pi").getByText("v1.0.0")).toBeVisible();
    expect(row("INSΠRE").getByText("v0.4.0")).toBeVisible();
    expect(screen.getAllByText("Not checked")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(fixture.checkPiUpdate).toHaveBeenCalledOnce();
    expect(fixture.checkInspireUpdate).toHaveBeenCalledOnce();
  });

  it("summarizes extension updates separately from their package sources", () => {
    availableUpdates();
    render(<SystemVersionsCard />);
    const extensions = row("Extensions");
    const summary = extensions.getByText("2 package updates").parentElement;
    const list = extensions.getByRole("list", {
      name: "Packages with updates",
    });
    expect(summary).toContainElement(
      extensions.getByRole("button", { name: "Copy pi update --extensions" }),
    );
    expect(summary).not.toContainElement(list);
    const packages = within(list);
    expect(packages.getAllByRole("listitem")).toHaveLength(2);
    expect(
      packages.getByRole("link", { name: "@example/pi-tools" }),
    ).toHaveAttribute(
      "href",
      "https://www.npmjs.com/package/@example/pi-tools",
    );
    expect(
      packages.getByRole("link", { name: "github.com/example/pi-tools" }),
    ).toHaveAttribute("href", "https://github.com/example/pi-tools");
  });

  it("distinguishes request submission from execution and retains known versions", () => {
    availableUpdates();
    fixture.state.piUpdateRequestPending = true;
    fixture.state.inspireUpdateChecking = true;
    const { rerender } = render(<SystemVersionsCard />);
    const check = screen.getByRole("button", { name: "Check for updates" });
    expect(check).toHaveTextContent("Submitting…");
    expect(check).toBeDisabled();
    expect(row("Pi").getByText("Submitting…")).toBeVisible();
    expect(row("Extensions").getByText("Submitting…")).toBeVisible();
    expect(row("INSΠRE").getByText("Checking…")).toBeVisible();
    expect(row("Pi").getByText("v1.0.0")).toBeVisible();
    expect(row("INSΠRE").getByText("v0.4.0")).toBeVisible();
    fireEvent.click(check);
    expect(fixture.checkPiUpdate).not.toHaveBeenCalled();
    expect(fixture.checkInspireUpdate).not.toHaveBeenCalled();

    fixture.state.piUpdateRequestPending = false;
    fixture.state.piUpdateChecking = true;
    fixture.state.inspireUpdateChecking = false;
    rerender(<SystemVersionsCard />);
    expect(check).toHaveTextContent("Checking…");
    expect(check).toBeDisabled();
    expect(row("Pi").getByText("Checking…")).toBeVisible();
    expect(row("Extensions").getByText("Checking…")).toBeVisible();

    fixture.state.piUpdateChecking = false;
    rerender(<SystemVersionsCard />);
    expect(check).toHaveTextContent("Check again");
    expect(check).toBeEnabled();
    expect(
      screen.getByRole("link", { name: "v1.1.0 available ↗" }),
    ).toHaveAttribute("href", "https://pi.dev/changelog");
    expect(
      screen.getByRole("link", { name: "v0.5.0 available ↗" }),
    ).toHaveAttribute("href", "https://example.com/inspire/release");
  });

  it.each([
    ["current", "current", "none", "Up to date", "Up to date", "No updates"],
    [
      "unavailable",
      "unavailable",
      "unavailable",
      "Check unavailable",
      "Check unavailable",
      "Check unavailable",
    ],
    [
      "current",
      "unreleased",
      "none",
      "Up to date",
      "No release published",
      "No updates",
    ],
  ] as const)(
    "reports Pi %s, Inspire %s and extension %s observations without claiming an update",
    (piKind, inspireKind, extensionsKind, piText, inspireText, extensionsText) => {
      fixture.state.piUpdateCheck = {
        currentVersion: "1.0.0",
        pi:
          piKind === "current"
            ? { kind: "current", latestVersion: "1.0.0" }
            : { kind: "unavailable" },
        extensions: { kind: extensionsKind },
      };
      fixture.state.inspireUpdateCheck = { kind: inspireKind };
      render(<SystemVersionsCard />);
      expect(row("Pi").getByText(piText)).toBeVisible();
      expect(row("INSΠRE").getByText(inspireText)).toBeVisible();
      expect(row("Extensions").getByText(extensionsText)).toBeVisible();
      expect(screen.queryByRole("button", { name: /^Copy pi/ })).toBeNull();
    },
  );

  it("copies native update commands with independent feedback and never submits them", async () => {
    availableUpdates();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<SystemVersionsCard />);
    const pi = screen.getByRole("button", { name: "Copy pi update" });
    const extensions = screen.getByRole("button", {
      name: "Copy pi update --extensions",
    });
    fireEvent.click(pi);
    expect(await within(pi).findByText("Copied")).toBeVisible();
    expect(within(extensions).queryByText("Copied")).toBeNull();
    fireEvent.click(extensions);
    expect(await within(extensions).findByText("Copied")).toBeVisible();
    expect(writeText.mock.calls).toEqual([
      ["pi update"],
      ["pi update --extensions"],
    ]);
    expect(fixture.checkPiUpdate).not.toHaveBeenCalled();
    expect(fixture.checkInspireUpdate).not.toHaveBeenCalled();
  });

  it("reports clipboard failure without confirming a copy", async () => {
    availableUpdates();
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("Clipboard denied");
        }),
      },
    });
    render(<SystemVersionsCard />);
    fireEvent.click(screen.getByRole("button", { name: "Copy pi update" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Clipboard denied",
    );
    expect(screen.queryByText("Copied")).toBeNull();
  });
});
