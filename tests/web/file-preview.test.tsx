// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialAppState } from "../../src/app-state";
import { selectContextPaneView } from "../../src/components/context-pane-view";
import { FilePreview } from "../../src/components/FilePreview";
import { store } from "../../src/store";
import type { FileReadingState } from "../../src/workbench-session";

afterEach(() => vi.restoreAllMocks());

const initial = {
  ...selectContextPaneView(createInitialAppState()),
  sessionId: "s1",
  cwd: "/project",
  resourcesOpen: true,
  fileBrowserView: "preview" as const,
  selectedResourceReference: "notes.md",
  selectedResourceWorkspacePath: "notes.md",
};
function ready(id: string, text = "# Notes\n\nOriginal source") {
  return {
    status: "ready" as const,
    reference: "notes.md",
    descriptor: {
      id,
      sessionId: "s1",
      viewId: "view-s1",
      reference: "notes.md",
      workspacePath: "notes.md",
      name: "notes.md",
      mimeType: "text/markdown",
      size: text.length,
      kind: "markdown" as const,
    },
    text,
    truncated: false,
  };
}

describe("Files source reading", () => {
  it("keeps the chosen Source view and both offsets across a refreshed file handle", () => {
    const { rerender } = render(
      <FilePreview state={{ ...initial, resourcePreview: ready("first") }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    const source = screen.getByRole("region", { name: "File source" });
    fireEvent.scroll(source, { target: { scrollTop: 137, scrollLeft: 48 } });
    rerender(
      <FilePreview
        state={{
          ...initial,
          resourcePreview: { ...ready("first"), refreshing: true },
        }}
      />,
    );
    expect(screen.getByRole("region", { name: "File source" })).toBe(source);
    expect(source).toHaveTextContent("Original source");
    rerender(
      <FilePreview
        state={{
          ...initial,
          resourcePreview: ready("renewed", "# Notes\n\nRefreshed source"),
        }}
      />,
    );
    const refreshed = screen.getByRole("region", { name: "File source" });
    expect(refreshed).toHaveTextContent("Refreshed source");
    expect(refreshed.scrollTop).toBe(137);
    expect(refreshed.scrollLeft).toBe(48);
    expect(screen.getByRole("button", { name: "Preview" })).toBeVisible();

    // A different file owns its default view; returning does not revive state.
    rerender(
      <FilePreview
        state={{
          ...initial,
          selectedResourceReference: "other.md",
          resourcePreview: ready("other"),
        }}
      />,
    );
    expect(screen.queryByRole("region", { name: "File source" })).toBeNull();
    rerender(
      <FilePreview state={{ ...initial, resourcePreview: ready("third") }} />,
    );
    expect(screen.queryByRole("region", { name: "File source" })).toBeNull();
  });

  it("retires HTML interaction while retaining static content during refresh", async () => {
    const release = vi.fn();
    const start = vi.spyOn(store, "createHtmlPreview").mockResolvedValue({
      url: "/html-preview/lease",
      release,
    });
    const preview = {
      ...ready("html", "<h1>Loaded page</h1>"),
      descriptor: {
        ...ready("html").descriptor,
        kind: "html" as const,
        mimeType: "text/html",
      },
      objectUrl: "blob:static-page",
    };
    const { rerender } = render(
      <FilePreview state={{ ...initial, resourcePreview: preview }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Enable interaction" }));
    await screen.findByRole("button", { name: "Stop interaction" });
    rerender(
      <FilePreview
        state={{
          ...initial,
          resourcePreview: { ...preview, refreshing: true },
        }}
      />,
    );
    expect(release).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Enable interaction" }),
    ).toBeDisabled();
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
      preview.objectUrl,
    );
    rerender(
      <FilePreview
        state={{
          ...initial,
          resourcePreview: { ...preview, refreshError: "Still unavailable" },
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing the last loaded content",
    );
    expect(
      screen.getByRole("button", { name: "Enable interaction" }),
    ).toBeEnabled();
    expect(start).toHaveBeenCalledOnce();
    rerender(<FilePreview state={{ ...initial, resourcePreview: preview }} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("retains source-only offsets on refresh but honors a new line target or file", () => {
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const style = computedStyle(element);
      if (element.classList.contains("source-view")) style.lineHeight = "20px";
      return style;
    });
    const preview = ready(
      "code",
      Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n"),
    );
    const state = {
      ...initial,
      selectedResourceReference: "first.ts",
      selectedResourceWorkspacePath: "first.ts",
      resourcePreview: {
        ...preview,
        reference: "first.ts",
        descriptor: {
          ...preview.descriptor,
          kind: "text" as const,
          name: "first.ts",
        },
      },
    };
    const { rerender } = render(<FilePreview state={state} />);
    fireEvent.scroll(screen.getByRole("region", { name: "File source" }), {
      target: { scrollTop: 137, scrollLeft: 48 },
    });
    rerender(
      <FilePreview
        state={{
          ...state,
          resourcePreview: { status: "loading", reference: "first.ts" },
        }}
      />,
    );
    rerender(<FilePreview state={state} />);
    const source = screen.getByRole("region", { name: "File source" });
    expect(source.scrollTop).toBe(137);
    expect(source.scrollLeft).toBe(48);
    rerender(
      <FilePreview
        state={{
          ...state,
          selectedResourceReference: "first.ts:20",
          resourcePreview: {
            ...state.resourcePreview,
            reference: "first.ts:20",
          },
        }}
      />,
    );
    expect(screen.getByRole("region", { name: "File source" }).scrollTop).toBe(
      380,
    );
    rerender(
      <FilePreview
        state={{
          ...state,
          selectedResourceReference: "second.ts",
          selectedResourceWorkspacePath: "second.ts",
        }}
      />,
    );
    expect(screen.getByRole("region", { name: "File source" }).scrollTop).toBe(
      0,
    );
    expect(screen.getByRole("region", { name: "File source" }).scrollLeft).toBe(
      0,
    );
  });

  it("does not carry source reading state to another session or transport", () => {
    const { rerender } = render(
      <FilePreview state={{ ...initial, resourcePreview: ready("first") }} />,
    );
    for (const owner of [
      { ...initial, sessionId: "s2" },
      { ...initial, sessionId: "s2", transportGeneration: 2 },
    ]) {
      fireEvent.click(screen.getByRole("button", { name: "Source" }));
      fireEvent.scroll(screen.getByRole("region", { name: "File source" }), {
        target: { scrollTop: 137, scrollLeft: 48 },
      });
      rerender(
        <FilePreview state={{ ...owner, resourcePreview: ready("renewed") }} />,
      );
      expect(screen.queryByRole("region", { name: "File source" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Source" }));
      const source = screen.getByRole("region", { name: "File source" });
      expect(source.scrollTop).toBe(0);
      expect(source.scrollLeft).toBe(0);
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    }
  });
});

describe("Files Git view", () => {
  const changes = {
    controls: <button type="button">Next change</button>,
    content: (
      <div
        role="region"
        aria-label="File changes"
        data-pane-scroll-active="true"
      >
        Changed file content
      </div>
    ),
  };

  it.each(["source", "preview"] as const)(
    "returns to the chosen %s body view without mixing its offsets with diff scrolling",
    (mode) => {
      const changeView = vi
        .spyOn(store, "setFileChangesView")
        .mockResolvedValue();
      const readingState: FileReadingState = {
        source: { current: { top: 137, left: 48 } },
        rendered: { current: { top: 263, left: 0 } },
        mode,
      };
      const state = { ...initial, resourcePreview: ready("file") };
      const { rerender, container } = render(
        <FilePreview state={state} readingState={readingState} />,
      );
      const actions = container.querySelector(".file-detail-header__actions")!;
      const buttons: HTMLElement[] = Array.from(
        actions.querySelectorAll("button"),
      );
      const git = screen.getByRole("button", { name: "Git changes" });
      const download = screen.getByRole("button", {
        name: "Download notes.md",
      });
      expect(buttons.at(-1)).toBe(download);
      expect(buttons.indexOf(git)).toBeLessThan(buttons.indexOf(download));
      expect(git).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(git);
      expect(changeView).toHaveBeenLastCalledWith(true);

      rerender(
        <FilePreview
          state={state}
          readingState={readingState}
          changes={changes}
        />,
      );
      expect(git).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Source" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
      expect(screen.queryByRole("region", { name: "File source" })).toBeNull();
      const diff = screen.getByRole("region", { name: "File changes" });
      fireEvent.scroll(diff, { target: { scrollTop: 801, scrollLeft: 90 } });
      expect(readingState.source.current).toEqual({ top: 137, left: 48 });
      expect(readingState.rendered.current).toEqual({ top: 263, left: 0 });
      fireEvent.click(git);
      expect(changeView).toHaveBeenLastCalledWith(false);

      rerender(<FilePreview state={state} readingState={readingState} />);
      expect(screen.queryByRole("region", { name: "File changes" })).toBeNull();
      expect(
        screen.getByRole("button", {
          name: mode === "source" ? "Preview" : "Source",
        }),
      ).toBeVisible();
      expect(readingState.mode).toBe(mode);
      if (mode === "source") {
        const source = screen.getByRole("region", { name: "File source" });
        expect(source.scrollTop).toBe(137);
        expect(source.scrollLeft).toBe(48);
      }
    },
  );

  it("opens the selected file's source directly from Git changes", () => {
    const changeView = vi
      .spyOn(store, "setFileChangesView")
      .mockResolvedValue();
    const readingState: FileReadingState = {
      source: { current: { top: 137, left: 48 } },
      rendered: { current: { top: 263, left: 0 } },
      mode: "preview",
    };
    const state = { ...initial, resourcePreview: ready("file") };
    const { container, rerender } = render(
      <FilePreview
        state={state}
        readingState={readingState}
        changes={changes}
      />,
    );
    const buttons = container.querySelectorAll(
      ".file-detail-header__actions button",
    );
    const source = screen.getByRole("button", { name: "Source" });
    expect(buttons[0]).toBe(source);
    expect(buttons[1]).toBe(
      screen.getByRole("button", { name: "Git changes" }),
    );
    fireEvent.click(source);
    expect(changeView).toHaveBeenCalledWith(false);
    expect(readingState.mode).toBe("source");
    expect(readingState.rendered.current).toEqual({ top: 263, left: 0 });
    rerender(<FilePreview state={state} readingState={readingState} />);
    expect(screen.getByRole("region", { name: "File source" }).scrollTop).toBe(
      137,
    );
  });

  it("keeps actions expanded through programmatic scrolling and collapses on reading intent", () => {
    const { container } = render(
      <FilePreview state={{ ...initial, resourcePreview: ready("file") }} />,
    );
    const content = container.querySelector(".file-preview__content")!;
    fireEvent.scroll(content);
    expect(screen.getByRole("button", { name: "Source" })).toBeVisible();
    fireEvent.wheel(content);
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show file actions" }));
    expect(screen.getByRole("button", { name: "Source" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("button", { name: "Source" }), {
      key: "Escape",
    });
    expect(
      screen.getByRole("button", { name: "Show file actions" }),
    ).toHaveFocus();
  });

  it("retires HTML execution when switching to Git and returns only to static preview", async () => {
    const release = vi.fn();
    const start = vi.spyOn(store, "createHtmlPreview").mockResolvedValue({
      url: "/html-preview/lease",
      release,
    });
    const preview = {
      ...ready("html", "<h1>Loaded page</h1>"),
      descriptor: {
        ...ready("html").descriptor,
        kind: "html" as const,
        mimeType: "text/html",
      },
      objectUrl: "blob:static-page",
    };
    const state = { ...initial, resourcePreview: preview };
    const { rerender, container } = render(<FilePreview state={state} />);
    fireEvent.click(screen.getByRole("button", { name: "Enable interaction" }));
    await screen.findByRole("button", { name: "Stop interaction" });

    rerender(<FilePreview state={state} changes={changes} />);
    expect(release).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /interaction/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Source" })).toBeVisible();
    expect(container.querySelector("iframe")).toBeNull();

    rerender(<FilePreview state={state} />);
    expect(
      screen.getByRole("button", { name: "Enable interaction" }),
    ).toBeEnabled();
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      preview.objectUrl,
    );
    expect(start).toHaveBeenCalledOnce();
  });

  it("shows a deleted file's diff while keeping its unavailable download disabled", () => {
    render(
      <FilePreview
        state={{
          ...initial,
          resourcePreview: {
            status: "error",
            reference: "notes.md",
            message: "File was deleted",
          },
        }}
        changes={changes}
      />,
    );
    expect(screen.getByRole("region", { name: "File changes" })).toBeVisible();
    expect(screen.queryByText("File was deleted")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Download unavailable" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Git changes" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Source" })).toBeDisabled();
  });
});
