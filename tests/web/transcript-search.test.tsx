// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Transcript,
  type TranscriptNavigation,
} from "../../src/components/Transcript";
import { findLiteralMatches } from "../../src/components/transcript-search";
import * as modalFocus from "../../src/use-modal-focus";
import { openTranscriptSearch } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("settled transcript search", () => {
  it("leaves the search shortcut to modal and expanded scope-menu owners", () => {
    render(
      <Transcript
        sessionId="owned-find"
        messages={[{ role: "user", content: "find this prompt", timestamp: 1 }]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const log = screen.getByRole("log");
    const modal = vi.spyOn(modalFocus, "hasActiveModal").mockReturnValue(true);
    expect(fireEvent.keyDown(log, { key: "f", ctrlKey: true })).toBe(true);
    expect(
      screen.getByRole("searchbox", { name: "Search conversation" }),
    ).not.toHaveFocus();
    modal.mockReturnValue(false);
    fireEvent.keyDown(log, { key: "f", ctrlKey: true });
    expect(
      screen.getByRole("searchbox", { name: "Search conversation" }),
    ).toHaveFocus();
    const scope = screen.getByRole("combobox", { name: "Search scope" });
    fireEvent.click(scope);
    scope.focus();
    expect(fireEvent.keyDown(scope, { key: "f", ctrlKey: true })).toBe(true);
    expect(scope).toHaveFocus();
    expect(scope).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps desktop search directly available and preserves its query on Escape", () => {
    const ref = createRef<TranscriptNavigation>();
    const props = {
      ref,
      sessionId: "desktop-search",
      messages: [{ role: "user", content: "find this prompt", timestamp: 1 }],
      streaming: false,
      thinkingVisibility: "collapsed" as const,
      toolVisibility: "collapsed" as const,
    };
    const { rerender } = render(<Transcript {...props} />);
    const input = screen.getByRole<HTMLInputElement>("searchbox", {
      name: "Search conversation",
    });
    expect(input).toBeInTheDocument();
    expect(
      screen.getByRole("search", { name: "Search conversation" }),
    ).not.toHaveAttribute("hidden");
    act(() => ref.current?.openSearch());
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "find" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 of 1");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("find");
    expect(input).not.toHaveFocus();
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 of 1");
    // An outside press does not retire a persistent desktop tool.
    fireEvent.pointerDown(screen.getByRole("log"));
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("find");
    fireEvent.keyDown(screen.getByRole("log"), { key: "f", ctrlKey: true });
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(4);
    rerender(<Transcript {...props} viewId="other-view" />);
    expect(input).toHaveValue("");
    expect(input).toBeInTheDocument();
  });

  it("keeps an active query visible when crossing between desktop and narrow search", () => {
    let narrow = false;
    let syncLayout: (() => void) | undefined;
    const matchMedia = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      ...matchMedia(query),
      get matches() {
        return query === "(max-width: 900px)" && narrow;
      },
      addEventListener: (_type: string, callback: unknown) => {
        if (query === "(max-width: 900px)") syncLayout = callback as () => void;
      },
    }));
    render(
      <Transcript
        sessionId="responsive-find"
        messages={[{ role: "user", content: "find this prompt", timestamp: 1 }]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const input = openTranscriptSearch();
    fireEvent.change(input, { target: { value: "find" } });
    act(() => {
      narrow = true;
      syncLayout?.();
    });
    expect(input).toHaveFocus();
    expect(
      screen.getByRole("search", { name: "Search conversation" }),
    ).toHaveClass("transcript-search--open");
    act(() => {
      narrow = false;
      syncLayout?.();
    });
    expect(input).toHaveValue("find");
    expect(
      screen.getByRole("search", { name: "Search conversation" }),
    ).not.toHaveClass("transcript-search--open");
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveFocus();
    act(() => {
      narrow = true;
      syncLayout?.();
    });
    expect(input).not.toHaveFocus();
    fireEvent.keyDown(screen.getByRole("log"), { key: "f", ctrlKey: true });
    fireEvent.change(input, { target: { value: "find" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(
      screen.getByRole("search", { name: "Search conversation" }),
    ).not.toHaveClass("transcript-search--open");
  });

  it.each([
    ["compactionSummary", "Context compacted"],
    ["branchSummary", "Branch context"],
  ])(
    "reveals a collapsed %s on every deliberate search navigation",
    (role, title) => {
      const props = {
        sessionId: "summary-search",
        streaming: false,
        thinkingVisibility: "collapsed" as const,
        toolVisibility: "collapsed" as const,
        messages: [
          { role, summary: "Retained decisions and next steps", timestamp: 1 },
        ],
      };
      const { rerender } = render(<Transcript {...props} />);
      const toggle = screen.getByRole("button", { name: title });
      const input = openTranscriptSearch();
      const next = screen.getByRole("button", {
        name: "Next transcript match",
      });
      fireEvent.change(input, { target: { value: "Retained decisions" } });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(next);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(
        screen.getByText("Retained decisions and next steps"),
      ).toBeVisible();
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      rerender(<Transcript {...props} />);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(next);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
    },
  );

  it("keeps the compact floating search and filters all, user, or model text", () => {
    render(
      <Transcript
        sessionId="scoped"
        messages={[
          {
            role: "user",
            content: "shared phrase, shared again from user",
            timestamp: 1,
          },
          {
            role: "assistant",
            content: "shared phrase from model",
            timestamp: 2,
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );

    const input = openTranscriptSearch();
    const search = screen.getByRole("search", {
      name: "Search conversation",
    });
    expect(search).not.toHaveClass("transcript-search--active");

    fireEvent.change(input, { target: { value: "shared" } });
    expect(search).toHaveClass("transcript-search--active");
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("3 matches");

    fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
    fireEvent.click(screen.getByRole("option", { name: "User" }));
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("2 matches");

    fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
    fireEvent.click(screen.getByRole("option", { name: "Model" }));
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 match");
    fireEvent.change(openTranscriptSearch(), { target: { value: "user" } });
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("0 matches");

    fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
    fireEvent.click(screen.getByRole("option", { name: "All" }));
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 match");

    fireEvent.change(input, { target: { value: "" } });
    expect(search).not.toHaveClass("transcript-search--active");
  });

  it("Escape releases desktop input focus without clearing matches or jumping to latest", () => {
    render(
      <Transcript
        sessionId="desktop-escape"
        messages={[{ role: "user", content: "find this prompt", timestamp: 1 }]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const input = openTranscriptSearch();
    fireEvent.change(input, { target: { value: "find" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Next transcript match" }),
    );
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).not.toHaveFocus();
    expect(input).toHaveValue("find");
    expect(
      screen.getByRole("search", { name: "Search conversation" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    { name: "active composition", isComposing: true },
    { name: "IME confirmation", isComposing: false, keyCode: 229 },
  ])(
    "leaves search keys to $name before navigating or releasing focus",
    (ime) => {
      render(
        <Transcript
          sessionId="composition-search"
          messages={[
            { role: "user", content: "find one, find two", timestamp: 1 },
          ]}
          streaming={false}
          thinkingVisibility="collapsed"
          toolVisibility="collapsed"
        />,
      );
      const input = openTranscriptSearch();
      const result = screen.getByLabelText("Transcript search matches");
      fireEvent.change(input, { target: { value: "find" } });
      fireEvent.click(
        screen.getByRole("button", { name: "Next transcript match" }),
      );
      expect(result).toHaveTextContent("1 of 2");
      input.focus();
      for (const key of ["Enter", "Escape"]) {
        expect(fireEvent.keyDown(input, { key, ...ime })).toBe(true);
        expect(result).toHaveTextContent("1 of 2");
        expect(input).toHaveFocus();
        expect(input).toHaveValue("find");
      }
      fireEvent.keyDown(input, { key: "Enter" });
      expect(result).toHaveTextContent("2 of 2");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(input).not.toHaveFocus();
      expect(input).toHaveValue("find");
    },
  );

  it("opens and closes narrow search explicitly", async () => {
    const matchMedia = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      ...matchMedia(query),
      matches: query === "(max-width: 900px)",
    }));
    const { container } = render(
      <Transcript
        sessionId="mobile-search"
        messages={[
          { role: "user", content: "find this prompt", timestamp: 1 },
          { role: "assistant", content: "settled answer", timestamp: 2 },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );

    const launcher = screen.getByRole("button", {
      name: "Open conversation search",
    });
    expect(launcher.closest(".transcript-mobile-toolbar")).not.toBeNull();
    fireEvent.click(launcher);
    const input = screen.getByRole("searchbox", {
      name: "Search conversation",
    });
    await waitFor(() => expect(input).toHaveFocus());
    expect(container.querySelector(".transcript-wrap")).toHaveClass(
      "transcript-wrap--mobile-search",
    );
    expect(
      screen.getByRole("search", { name: "Search conversation" }),
    ).toHaveClass("transcript-search--open");

    fireEvent.change(input, { target: { value: "find" } });
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 match");
    fireEvent.click(
      screen.getByRole("button", { name: "Close conversation search" }),
    );

    expect(input).toHaveValue("");
    expect(container.querySelector(".transcript-wrap")).toHaveClass(
      "transcript-wrap--mobile-idle",
    );
    expect(
      screen.getByRole("search", { name: "Search conversation" }),
    ).not.toHaveClass("transcript-search--open");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open conversation search" }),
      ).toHaveFocus(),
    );
  });

  it("finds case-insensitive literal occurrences only in settled user and assistant text", () => {
    expect(findLiteralMatches("Alpha alpha alphabet", "ALPHA", 3)).toEqual([
      { rowIndex: 3, offset: 0 },
      { rowIndex: 3, offset: 6 },
      { rowIndex: 3, offset: 12 },
    ]);

    const messages = [
      { role: "user", content: "Alpha alpha", timestamp: 1 },
      {
        role: "assistant",
        timestamp: 2,
        content: [
          { type: "text", text: "BETA beta" },
          { type: "thinking", thinking: "hidden needle" },
          {
            type: "toolCall",
            id: "tool-1",
            name: "search",
            arguments: { query: "needle" },
          },
        ],
      },
      {
        role: "assistant",
        timestamp: 3,
        content: [{ type: "text", text: "live beta" }],
        __inspireLiveId: "assistant-live",
      },
      {
        role: "user",
        content: "unsettled beta",
        timestamp: 4,
        __inspireLiveId: "user-live",
      },
    ];
    const { rerender } = render(
      <Transcript
        sessionId="s1"
        messages={messages}
        streaming
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const input = openTranscriptSearch();

    fireEvent.change(input, { target: { value: "beta" } });
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("2 matches");
    fireEvent.click(
      screen.getByRole("button", { name: "Next transcript match" }),
    );
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 of 2");
    fireEvent.click(
      screen.getByRole("button", { name: "Previous transcript match" }),
    );
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("2 of 2");
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "needle" } });
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("0 matches");

    fireEvent.change(input, { target: { value: "beta" } });
    rerender(
      <Transcript
        sessionId="s1"
        messages={[
          { role: "user", content: "older beta", timestamp: 0 },
          ...messages.map((message) =>
            message.timestamp === 3
              ? { ...message, __inspireSettled: true }
              : message,
          ),
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("4 matches");

    rerender(
      <Transcript
        sessionId="s2"
        messages={[
          { role: "user", content: "beta in another session", timestamp: 10 },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(openTranscriptSearch()).toHaveValue("");
  });
});
