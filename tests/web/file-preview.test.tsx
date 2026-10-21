// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialAppState } from "../../src/app-state";
import { selectContextPaneView } from "../../src/components/context-pane-view";
import { FilePreview } from "../../src/components/FilePreview";

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
          resourcePreview: { status: "loading", reference: "notes.md" },
        }}
      />,
    );
    expect(screen.getByText("Loading preview")).toBeVisible();
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
