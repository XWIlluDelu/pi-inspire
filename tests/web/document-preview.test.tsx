// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceDescriptor } from "../../shared/contracts";
import { DocumentPreview } from "../../src/components/DocumentPreview";
import { NotebookPreview } from "../../src/components/NotebookPreview";
import { RichText } from "../../src/components/RichText";
import { store } from "../../src/store";
import { deferred } from "./helpers";

const descriptor: ResourceDescriptor = {
  id: "document-1",
  sessionId: "s1",
  viewId: "view-s1",
  reference: "README.md",
  workspacePath: "reports/README.md",
  name: "README.md",
  mimeType: "text/markdown",
  size: 100,
  kind: "markdown",
};
const raster =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
const preview = (text: string, resource = descriptor) => (
  <DocumentPreview descriptor={resource} className="test-document">
    <RichText text={text} />
  </DocumentPreview>
);

describe("document Markdown", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:document-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    Element.prototype.scrollIntoView = vi.fn();
    vi.spyOn(store, "loadDocumentImage").mockResolvedValue(
      new Blob(["image"], { type: "image/png" }),
    );
    vi.spyOn(store, "openResource").mockResolvedValue();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves authored local links and inline paths without intercepting external links", () => {
    render(
      preview(
        "[`Guide.md`](../guide.md#results) [License](LICENSE) `./config.yaml`\n\n[![Build status](https://pi.dev/status.svg)](https://pi.dev/build)",
      ),
    );
    fireEvent.click(screen.getByRole("link", { name: "Guide.md" }));
    fireEvent.click(screen.getByRole("link", { name: "License" }));
    fireEvent.click(screen.getByRole("button", { name: "./config.yaml" }));
    const external = screen.getByRole("link", { name: /Build status/ });
    expect(external).toHaveAttribute("href", "https://pi.dev/build");
    expect(fireEvent.click(external)).toBe(true);
    expect(
      vi.mocked(store.openResource).mock.calls.map(([reference]) => reference),
    ).toEqual([
      "./reports/../guide.md#results",
      "./reports/LICENSE",
      "./reports/./config.yaml",
    ]);
    expect(store.loadDocumentImage).not.toHaveBeenCalled();
  });

  it("keeps heading anchors inside the document, including Unicode and duplicates", () => {
    render(
      preview(
        "[Results](#训练结果) [Again](#训练结果-1)\n\n## 训练结果\n\n## 训练结果",
      ),
    );
    const headings = screen.getAllByRole("heading");
    expect(headings.map((heading) => heading.id)).toEqual([
      "user-content-训练结果",
      "user-content-训练结果-1",
    ]);
    fireEvent.click(screen.getByRole("link", { name: "Again" }));
    expect(headings[1]!.scrollIntoView).toHaveBeenCalled();
    expect(store.openResource).not.toHaveBeenCalled();
  });

  it("follows an incoming fragment after lazy notebook content and eager output layout settle", async () => {
    render(
      <DocumentPreview
        descriptor={{ ...descriptor, reference: "report.ipynb#results" }}
        className="test-document"
      >
        <NotebookPreview
          text={JSON.stringify({
            cells: [
              {
                cell_type: "code",
                source: "",
                outputs: [
                  {
                    output_type: "display_data",
                    data: { "image/png": raster },
                  },
                ],
              },
              { cell_type: "markdown", source: "## Results" },
            ],
          })}
        />
      </DocumentPreview>,
    );
    await screen.findByRole("heading", { name: "Results" });
    const image = screen.getByRole("img", { name: "Notebook output" });
    expect(image).toHaveAttribute("loading", "eager");
    Object.defineProperty(image, "complete", { value: true });
    fireEvent.load(image);
    await waitFor(() =>
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled(),
    );
  });

  it.each([false, true])(
    "waits for image layout before incoming anchors; user cancellation=%s",
    async (cancel) => {
      vi.useFakeTimers({
        toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
      });
      render(
        preview("## Results\n\n![Curve](curve.png)", {
          ...descriptor,
          reference: "reports/README.md#results",
        }),
      );
      const image = await screen.findByRole("img", { name: "Curve" });
      // jsdom does not decode blob images; explicitly deliver the browser's load.
      act(() => vi.advanceTimersToNextFrame());
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
      if (cancel) fireEvent.wheel(image);
      Object.defineProperty(image, "complete", {
        configurable: true,
        value: true,
      });
      fireEvent.load(image);
      act(() => vi.advanceTimersToNextFrame());
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(
        cancel ? 0 : 1,
      );
    },
  );

  it("shows failures and decode errors without falling back to raw paths", async () => {
    vi.mocked(store.loadDocumentImage).mockRejectedValueOnce(
      new Error("The file is not authorized"),
    );
    const { rerender } = render(preview("![Missing curve](missing.png)"));
    const failure = await screen.findByText(
      "Missing curve · Image unavailable",
    );
    expect(failure).toHaveAttribute("title", "The file is not authorized");
    expect(screen.queryByRole("img")).toBeNull();
    rerender(preview("![Corrupt curve](corrupt.png)"));
    fireEvent.error(await screen.findByRole("img", { name: "Corrupt curve" }));
    expect(
      screen.getByText("Corrupt curve · Image unavailable"),
    ).toHaveAttribute("title", "Image could not be decoded");
  });

  it("never auto-loads remote, protocol-relative, data, raw HTML or unrecognized conversation image URLs", () => {
    const text =
      '![Remote](https://attacker.invalid/pixel) ![Protocol relative](//attacker.invalid/pixel) ![Data](data:image/png;base64,AAAA) <img src="https://attacker.invalid/raw">';
    const { container } = render(
      <>
        {preview(text)}
        <RichText text={`${text} ![Unknown](unrecognized-format)`} />
      </>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(store.loadDocumentImage).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole("link", { name: /Protocol relative/ })[0],
    ).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("rejects late images after document replacement and survives StrictMode replay", async () => {
    const late = deferred<Blob>();
    vi.mocked(store.loadDocumentImage).mockImplementation((_id, reference) =>
      reference.includes("old")
        ? late.promise
        : Promise.resolve(new Blob(["new"])),
    );
    const { rerender } = render(
      <StrictMode>{preview("![Old](old.png)")}</StrictMode>,
    );
    await waitFor(() => expect(store.loadDocumentImage).toHaveBeenCalled());
    const oldSignal = vi.mocked(store.loadDocumentImage).mock.calls.at(-1)![2];
    rerender(
      <StrictMode>
        {preview("![New](new.png)", { ...descriptor, id: "document-2" })}
      </StrictMode>,
    );
    expect(oldSignal.aborted).toBe(true);
    await screen.findByRole("img", { name: "New" });
    await act(async () => late.resolve(new Blob(["stale"])));
    expect(screen.queryByRole("img", { name: "Old" })).toBeNull();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("highlights notebook code, preserves raw source and separates traceback lines", () => {
    const source = 'print("<unsafe>", 42)';
    const traceback = [
      "\u001b]0;notebook title\u0007\u001b[31mTraceback (most recent call last):\u001b[0m",
      '  File "train.py", line 8',
      "ValueError: invalid sample",
    ];
    const { container } = render(
      <NotebookPreview
        text={JSON.stringify({
          metadata: { language_info: { name: "py" } },
          cells: [
            {
              cell_type: "code",
              source,
              outputs: [{ output_type: "error", traceback }],
            },
            { cell_type: "raw", source },
          ],
        })}
      />,
    );
    const code = container.querySelector(".notebook-preview__cell--code code")!;
    expect(code.textContent).toBe(source);
    expect(code.querySelector("span")).toBeInTheDocument();
    expect(code.querySelector("unsafe")).toBeNull();
    const raw = container.querySelector(".notebook-preview__cell--raw code")!;
    expect(raw.textContent).toBe(source);
    expect(raw.querySelector("span")).toBeNull();
    expect(
      container.querySelector(".notebook-preview__output--error pre")!
        .textContent,
    ).toBe(
      'Traceback (most recent call last):\n  File "train.py", line 8\nValueError: invalid sample',
    );
  });

  it.each([
    [{ kernelspec: { name: "python3" } }, "print(42)", true],
    [{ kernelspec: { name: "julia-1.11" } }, "function f()\nend", true],
    [{ kernelspec: { name: "deno" } }, "const x = 42", true],
    [
      {
        language_info: { name: "plaintext" },
        kernelspec: { language: "python", name: "python3" },
      },
      "print(42)",
      false,
    ],
    [
      { kernelspec: { language: "plaintext", name: "python3" } },
      "print(42)",
      false,
    ],
    [{ kernelspec: { name: "constructor" } }, "print(42)", false],
  ])(
    "uses explicit language before recognized kernel names: %j",
    (metadata, source, highlighted) => {
      const { container } = render(
        <NotebookPreview
          text={JSON.stringify({
            metadata,
            cells: [{ cell_type: "code", source }],
          })}
        />,
      );
      const code = container.querySelector(
        ".notebook-preview__cell--code code",
      )!;
      expect(code.textContent).toBe(source);
      expect(code.childElementCount > 0).toBe(highlighted);
    },
  );

  it("keeps notebook attachments local to their own cell and accepts only raster data", async () => {
    const text = JSON.stringify({
      cells: [
        {
          cell_type: "markdown",
          source: "![Attached](attachment:plot%20one.png)",
          attachments: { "plot one.png": { "image/png": raster } },
        },
        {
          cell_type: "markdown",
          source:
            "![Other cell](attachment:plot%20one.png) ![Unsafe](attachment:active.svg)",
          attachments: {
            "active.svg": { "image/svg+xml": "<svg onload='bad()'/>" },
          },
        },
      ],
    });
    render(
      <DocumentPreview descriptor={descriptor} className="test-document">
        <NotebookPreview text={text} />
      </DocumentPreview>,
    );
    expect(
      await screen.findByRole("img", { name: "Attached" }),
    ).toHaveAttribute("src", `data:image/png;base64,${raster}`);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByText("Other cell · Image unavailable")).toBeVisible();
    expect(screen.getByText("Unsafe · Image unavailable")).toBeVisible();
    expect(store.loadDocumentImage).not.toHaveBeenCalled();
  });
});
