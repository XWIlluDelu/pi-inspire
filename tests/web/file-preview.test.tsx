// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialAppState } from "../../src/app-state";
import { selectContextPaneView } from "../../src/components/context-pane-view";
import { FilePreview } from "../../src/components/FilePreview";
import {
  injectHtmlPreviewCsp,
  type ResourcePreview,
} from "../../src/resource-preview";

afterEach(() => vi.restoreAllMocks());

const initial = {
  ...selectContextPaneView(createInitialAppState()),
  sessionId: "s1",
  cwd: "/project",
  resourcesOpen: true,
};
function fileState(preview: ResourcePreview) {
  return {
    ...initial,
    fileInspection: {
      kind: "file" as const,
      reference: preview.reference,
      workspacePath: preview.reference,
      preview,
    },
  };
}

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

it("inserts the static HTML policy into the document head and removes redirects", () => {
  const html = injectHtmlPreviewCsp(
    '<!-- <head> --><base href="https://example.invalid/"><meta http-equiv="refresh" content="0;url=https://example.invalid/"><h1>Preview</h1>',
  );
  const document = new DOMParser().parseFromString(html, "text/html");
  expect(
    document.head
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content"),
  ).toContain("default-src 'none'");
  expect(document.querySelector("base, meta[http-equiv='refresh']")).toBeNull();
  expect(document.body.textContent).toBe("Preview");
});

describe("Files reading continuity", () => {
  it.each([
    { kind: "markdown", text: "# Notes", mimeType: "text/markdown" },
    { kind: "html", text: "<h1>Notes</h1>", mimeType: "text/html" },
    { kind: "image", text: "<svg>", mimeType: "image/svg+xml" },
  ] as const)(
    "offers bounded $kind Source at the preview limit",
    ({ kind, text, mimeType }) => {
      const preview = ready("bounded", text);
      const tooLarge = kind === "image";
      const { container } = render(
        <FilePreview
          state={fileState({
            ...preview,
            descriptor: { ...preview.descriptor, kind, mimeType },
            objectUrl: kind === "html" ? "blob:bounded" : undefined,
            contentUnavailable: tooLarge ? "too-large" : undefined,
            truncated: true,
          })}
        />,
      );
      expect(
        screen.getByText(
          tooLarge
            ? "File too large to preview"
            : "Preview truncated. See the cutoff in Source.",
        ),
      ).toBeVisible();
      if (kind === "html") {
        expect(container.querySelector("iframe")).toHaveAttribute(
          "sandbox",
          "",
        );
        expect(
          screen.queryByRole("button", { name: "Enable interaction" }),
        ).toBeNull();
      }
      fireEvent.click(screen.getByRole("button", { name: "Source" }));
      expect(
        screen.getByRole("region", { name: "File source" }),
      ).toHaveTextContent(text);
      expect(screen.getByText("Preview ends here")).toBeVisible();
    },
  );

  it("does not carry source reading state to another session or transport", () => {
    const { rerender } = render(
      <FilePreview state={fileState(ready("first"))} />,
    );
    for (const owner of [
      { sessionId: "s2" },
      { sessionId: "s2", transportGeneration: 2 },
    ]) {
      fireEvent.click(screen.getByRole("button", { name: "Source" }));
      fireEvent.scroll(screen.getByRole("region", { name: "File source" }), {
        target: { scrollTop: 137, scrollLeft: 48 },
      });
      rerender(
        <FilePreview state={{ ...fileState(ready("renewed")), ...owner }} />,
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

  it("keeps actions expanded through programmatic scrolling and collapses on reading intent", () => {
    const { container } = render(
      <FilePreview state={fileState(ready("file"))} />,
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

  it("shows a deleted file's diff while keeping its unavailable download disabled", () => {
    render(
      <FilePreview
        state={fileState({
          status: "error",
          reference: "notes.md",
          message: "File was deleted",
        })}
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
