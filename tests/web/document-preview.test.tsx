// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  afterEach(() => vi.restoreAllMocks());

  it("renders local images in place, preserving linked images, alt text and titles", async () => {
    const { container, unmount } = render(
      preview(
        '![Training curve](figures/curve.png "Validation MSE")\n\n[![Linked curve](figures/curve.png)](details.md)',
      ),
    );
    const image = await screen.findByRole("img", { name: "Training curve" });
    expect(image).toHaveAttribute("src", "blob:document-image");
    expect(image).toHaveAttribute("title", "Validation MSE");
    expect(container.querySelector("p img")).toBeTruthy();
    expect(container.querySelector("a button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview curve.png" }));
    expect(
      screen.getByRole("dialog", { name: "Image preview" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Image preview" }),
      ).toBeNull(),
    );
    expect(store.loadDocumentImage).toHaveBeenCalledTimes(1);
    expect(store.loadDocumentImage).toHaveBeenCalledWith(
      "document-1",
      "./reports/figures/curve.png",
      expect.any(AbortSignal),
    );
    fireEvent.click(screen.getByRole("img", { name: "Linked curve" }));
    expect(store.openResource).toHaveBeenCalledWith("./reports/details.md");
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:document-image");
  });

  it("resolves relative file links, extensionless links and inline paths from the document directory", () => {
    render(
      preview(
        "[Guide](../guide.md#results) [License](LICENSE) `./config.yaml`",
      ),
    );
    fireEvent.click(screen.getByRole("link", { name: "Guide" }));
    fireEvent.click(screen.getByRole("link", { name: "License" }));
    fireEvent.click(screen.getByRole("button", { name: "./config.yaml" }));
    expect(
      vi.mocked(store.openResource).mock.calls.map(([reference]) => reference),
    ).toEqual([
      "./reports/../guide.md#results",
      "./reports/LICENSE",
      "./reports/./config.yaml",
    ]);
  });

  it("preserves authored code and remote-image links in a document", () => {
    const { container } = render(
      preview(
        "[`README.md`](../guide.md#results)\n\n[`CHANGELOG.md`](https://pi.dev/changes)\n\n[![Build status](https://pi.dev/status.svg)](https://pi.dev/build)",
      ),
    );
    expect(fireEvent.click(screen.getByText("README.md"))).toBe(false);
    expect(store.openResource).toHaveBeenCalledExactlyOnceWith(
      "./reports/../guide.md#results",
    );
    vi.mocked(store.openResource).mockClear();
    for (const [label, href] of [
      ["CHANGELOG.md", "https://pi.dev/changes"],
      ["Build status", "https://pi.dev/build"],
    ]) {
      const target = screen.getByText(label);
      expect(target.closest("a")).toHaveAttribute("href", href);
      expect(fireEvent.click(target)).toBe(true);
    }
    expect(store.openResource).not.toHaveBeenCalled();
    expect(store.loadDocumentImage).not.toHaveBeenCalled();
    expect(container.querySelector("a button, a a, img")).toBeNull();
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
      render(
        preview("## Results\n\n![Curve](curve.png)", {
          ...descriptor,
          reference: "reports/README.md#results",
        }),
      );
      const image = await screen.findByRole("img", { name: "Curve" });
      // jsdom does not decode blob images; explicitly deliver the browser's load.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
      if (cancel) fireEvent.wheel(image);
      Object.defineProperty(image, "complete", {
        configurable: true,
        value: true,
      });
      fireEvent.load(image);
      if (cancel) {
        await act(
          async () => new Promise((resolve) => setTimeout(resolve, 30)),
        );
        expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
      } else
        await waitFor(() =>
          expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1),
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

  it("retains the conversation's explicit-open image behavior", () => {
    render(<RichText text="![Conversation curve](figures/curve.png)" />);
    expect(
      screen.getByRole("button", { name: "Preview Conversation curve" }),
    ).toHaveAttribute("data-file-path", "figures/curve.png");
    expect(store.loadDocumentImage).not.toHaveBeenCalled();
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
    expect(code.querySelector(".hljs-built_in")).toHaveTextContent("print");
    expect(code.querySelector(".hljs-number")).toHaveTextContent("42");
    expect(code.querySelector("unsafe")).toBeNull();
    const raw = container.querySelector(".notebook-preview__cell--raw code")!;
    expect(raw.textContent).toBe(source);
    expect(raw.children).toHaveLength(0);
    expect(
      container.querySelector(".notebook-preview__output--error pre")!
        .textContent,
    ).toBe(
      'Traceback (most recent call last):\n  File "train.py", line 8\nValueError: invalid sample',
    );
  });

  it.each([
    [{ kernelspec: { name: "python3" } }, "print(42)", "hljs-built_in"],
    [
      { kernelspec: { name: "julia-1.11" } },
      "function f()\nend",
      "hljs-keyword",
    ],
    [{ kernelspec: { name: "ir" } }, "TRUE", "hljs-literal"],
    [{ kernelspec: { name: "deno" } }, "const x = 42", "hljs-keyword"],
    [
      { language_info: { name: "plaintext" }, kernelspec: { name: "python3" } },
      "print(42)",
      null,
    ],
    [
      { kernelspec: { language: "plaintext", name: "python3" } },
      "print(42)",
      null,
    ],
    [{ kernelspec: { name: "custom-python-environment" } }, "print(42)", null],
    [{ kernelspec: { name: "constructor" } }, "print(42)", null],
    [{ kernelspec: { name: "__proto__" } }, "print(42)", null],
    [{}, "print(42)", null],
  ])(
    "uses explicit language before recognized kernel names: %j",
    (metadata, source, token) => {
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
      if (token) expect(code.querySelector(`.${token}`)).not.toBeNull();
      else expect(code.children).toHaveLength(0);
    },
  );

  it("renders Notebook Markdown/output file images and cell-local attachments without executing HTML", async () => {
    const text = JSON.stringify({
      cells: [
        {
          cell_type: "markdown",
          source:
            "![Cell file](figures/curve.png) ![Attached](attachment:plot%20one.png)",
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
        {
          cell_type: "code",
          source: "",
          outputs: [
            {
              output_type: "display_data",
              data: { "text/markdown": "![Output file](../output.png)" },
            },
            { output_type: "display_data", data: { "image/png": raster } },
          ],
        },
      ],
    });
    render(
      <DocumentPreview descriptor={descriptor} className="test-document">
        <NotebookPreview text={text} />
      </DocumentPreview>,
    );
    const notebook = await screen.findByRole("document", {
      name: "Notebook preview",
    });
    expect(
      await within(notebook).findByRole("img", { name: "Attached" }),
    ).toHaveAttribute("src", `data:image/png;base64,${raster}`);
    await within(notebook).findByRole("img", { name: "Cell file" });
    await within(notebook).findByRole("img", { name: "Output file" });
    expect(
      within(notebook).getByRole("img", { name: "Notebook output" }),
    ).toHaveAttribute("loading", "lazy");
    fireEvent.click(
      within(notebook).getByRole("button", { name: "Preview Notebook output" }),
    );
    const viewer = screen.getByRole("dialog", { name: "Image preview" });
    expect(viewer.querySelector("img")).not.toHaveAttribute("loading", "lazy");
    expect(viewer.querySelector("img")).toHaveAttribute(
      "src",
      `data:image/png;base64,${raster}`,
    );
    expect(
      within(viewer).getByRole("group", { name: "Image navigation" }),
    ).toHaveTextContent("4 / 4");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Image preview" }),
      ).toBeNull(),
    );
    expect(
      within(notebook).queryByRole("img", { name: "Other cell" }),
    ).toBeNull();
    expect(
      within(notebook).getByText("Other cell · Image unavailable"),
    ).toBeVisible();
    expect(
      within(notebook).getByText("Unsafe · Image unavailable"),
    ).toBeVisible();
    expect(
      vi.mocked(store.loadDocumentImage).mock.calls.map(([, ref]) => ref),
    ).toEqual(["./reports/figures/curve.png", "./reports/../output.png"]);
  });
});
