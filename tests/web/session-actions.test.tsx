// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_CONTEXT_HEADING } from "../../shared/attachment-context";
import { createInitialAppState } from "../../src/app-state";
import { AppTopbar } from "../../src/components/AppTopbar";
import { sessionHeading } from "../../src/session-actions";
import { store } from "../../src/store";
import { deferred } from "./helpers";

describe("Session headings", () => {
  it.each(["Review this report", ""])(
    "uses the same file-aware title before and after catalog refresh for %j",
    (text) => {
      const trailer = `${ATTACHMENT_CONTEXT_HEADING}\n- "/demo/report.csv"`;
      const messages = [
        {
          role: "user" as const,
          content: text ? `${text}\n\n${trailer}` : trailer,
        },
        { role: "user" as const, content: "A later question" },
      ];
      const title = text || "report.csv";
      expect(sessionHeading("", undefined, messages, true)).toBe(title);
      expect(sessionHeading("", title, messages, false)).toBe(title);
      expect(sessionHeading("Named report", title, messages, true)).toBe(
        "Named report",
      );
      expect(sessionHeading("", undefined, messages, false)).toBe(
        "New session",
      );
    },
  );
});

const sessionId = "01a163f4-8e43-71df-9bd6-71efa60bd123";
function renderTopbar(readOnly = false) {
  vi.spyOn(store, "getState").mockReturnValue({
    ...createInitialAppState(),
    sessionId,
    sessionName: "Original title",
    cwd: "/workspace/report",
    gitStatus: { kind: "not-repository" },
    readOnlyReason: readOnly ? "workspace-unavailable" : null,
  });
  const noop = () => {};
  render(
    <AppTopbar
      narrowViewport={false}
      mobileNavOpen={false}
      settingsOpen={false}
      onToggleNavigation={noop}
      onOpenCommandPalette={noop}
      onExportSession={noop}
      onToggleSettings={noop}
      onToggleResources={noop}
    />,
  );
}

it.each(["resolve", "reject"] as const)(
  "retires project path copy %s when the session owner changes",
  async (outcome) => {
    renderTopbar();
    const write = deferred<void>();
    userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockReturnValue(write.promise);
    let owned = true;
    vi.spyOn(store, "copyOwnership").mockReturnValue(() => owned);
    const report = vi
      .spyOn(store, "reportCopyError")
      .mockImplementation(() => {});
    const path = screen.getByRole("button", { name: "Copy project path" });
    fireEvent.click(path);
    expect(writeText).toHaveBeenCalledWith("/workspace/report");
    owned = false;
    await act(async () => {
      if (outcome === "resolve") write.resolve();
      else write.reject(new Error("Retired clipboard result"));
    });
    expect(path).not.toHaveAttribute("title", "Copied");
    expect(report).not.toHaveBeenCalled();
  },
);

describe("Session actions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("copies the complete ID in read-only sessions and reports clipboard failure before retry", async () => {
    const user = userEvent.setup();
    let completeCopy!: () => void;
    const clipboard = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("Clipboard permission denied"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            completeCopy = resolve;
          }),
      );
    const onCopyError = vi.spyOn(store, "reportCopyError");
    vi.spyOn(store, "copyOwnership").mockReturnValue(() => true);
    renderTopbar(true);
    await user.click(screen.getByRole("button", { name: /^Session actions:/ }));
    const copy = screen.getByRole("menuitem", { name: "Copy session ID" });
    expect(copy).toHaveFocus();
    expect(
      screen.getByRole("menuitem", { name: "Rename session" }),
    ).toBeDisabled();
    await user.click(copy);
    expect(onCopyError).toHaveBeenCalledWith("Clipboard permission denied");
    expect(screen.queryByText("ID copied")).toBeNull();
    await user.click(copy);
    expect(clipboard).toHaveBeenLastCalledWith(
      "01a163f4-8e43-71df-9bd6-71efa60bd123",
    );
    // Native disabled buttons lose focus in browsers during clipboard writes.
    expect(copy).not.toBeDisabled();
    expect(copy).toHaveAttribute("aria-disabled", "true");
    expect(copy).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(clipboard).toHaveBeenCalledTimes(2);
    await act(async () => completeCopy());
    expect(
      await screen.findByRole("menuitem", { name: "ID copied" }),
    ).toHaveFocus();
    expect(screen.getByRole("menu", { name: "Session actions" })).toBeVisible();
  });
});
