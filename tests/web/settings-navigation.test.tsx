// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../../src/components/Settings";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("Settings component UX and navigation", () => {
  it("renders all categories as ordinary navigation", () => {
    render(<Settings onClose={() => undefined} />);
    const navigation = screen.getByRole("navigation", {
      name: "Settings categories",
    });

    for (const name of [
      "Appearance",
      "Transcript",
      "Attention",
      "Startup",
      "Install",
      "About",
    ]) {
      expect(
        within(navigation).getByRole("button", { name }),
      ).toBeInTheDocument();
    }
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("marks the current category when navigating", () => {
    render(<Settings onClose={() => undefined} />);
    const navigation = screen.getByRole("navigation", {
      name: "Settings categories",
    });
    const transcript = within(navigation).getByRole("button", {
      name: "Transcript",
    });

    fireEvent.click(transcript);
    expect(transcript).toHaveAttribute("aria-current", "true");
  });

  it("filters visible sections in real time when searching", () => {
    render(<Settings onClose={() => undefined} />);
    const searchInput = screen.getByPlaceholderText("Search settings...");

    fireEvent.change(searchInput, { target: { value: "theme" } });
    expect(
      screen.getByRole("region", { name: "Appearance" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Startup" }),
    ).not.toBeInTheDocument();

    fireEvent.change(searchInput, {
      target: { value: "nonexistent-query-xyz" },
    });
    expect(screen.getByText("No settings found")).toBeInTheDocument();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Clear search" })[0]!,
    );
    expect(
      screen.getByRole("region", { name: "Appearance" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Startup" })).toBeInTheDocument();
  });

  it("clears search on Escape before closing Settings", () => {
    const onClose = vi.fn();
    render(<Settings onClose={onClose} />);
    const searchInput = screen.getByRole("textbox", {
      name: "Search settings",
    });

    fireEvent.change(searchInput, { target: { value: "notification" } });
    fireEvent.keyDown(searchInput, { key: "Escape" });
    expect(searchInput).toHaveValue("");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(searchInput, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("restores filtered sections before scrolling to a category", async () => {
    render(<Settings onClose={() => undefined} />);
    const searchInput = screen.getByRole("textbox", {
      name: "Search settings",
    });
    const navigation = screen.getByRole("navigation", {
      name: "Settings categories",
    });

    fireEvent.change(searchInput, { target: { value: "theme" } });
    expect(screen.queryByRole("region", { name: "About" })).toBeNull();
    fireEvent.click(within(navigation).getByRole("button", { name: "About" }));

    const about = await screen.findByRole("region", { name: "About" });
    await waitFor(() => expect(about.scrollIntoView).toHaveBeenCalled());
    expect(searchInput).toHaveValue("");
    expect(
      within(navigation).getByRole("button", { name: "About" }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("clears search with the explicit clear button", () => {
    render(<Settings onClose={() => undefined} />);
    const searchInput = screen.getByRole("textbox", {
      name: "Search settings",
    });

    fireEvent.change(searchInput, { target: { value: "notification" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(searchInput).toHaveValue("");
    expect(searchInput).toHaveFocus();
  });
});
