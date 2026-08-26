// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ResourcePathLabel,
  resourcePathCandidates,
} from "../../src/components/ResourcePathLabel";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resource path projections", () => {
  it("preserves the leaf, nearest parent, and project root as width decreases", () => {
    expect(
      resourcePathCandidates(
        "tests/browser/fixtures/file-previews/notebook.ipynb",
      ).slice(0, 4),
    ).toEqual([
      "tests/browser/fixtures/file-previews/notebook.ipynb",
      "tests/…/file-previews/notebook.ipynb",
      "…/file-previews/notebook.ipynb",
      "notebook.ipynb",
    ]);
  });

  it("preserves Windows and UNC roots and their native separators", () => {
    expect(
      resourcePathCandidates("C:\\Users\\research\\outputs\\result.csv").slice(
        0,
        3,
      ),
    ).toEqual([
      "C:\\Users\\research\\outputs\\result.csv",
      "C:\\…\\outputs\\result.csv",
      "…\\outputs\\result.csv",
    ]);
    expect(
      resourcePathCandidates("\\\\server\\share\\project\\src\\main.ts").slice(
        0,
        3,
      ),
    ).toEqual([
      "\\\\server\\share\\project\\src\\main.ts",
      "\\\\server\\share\\…\\src\\main.ts",
      "…\\src\\main.ts",
    ]);
  });

  it("preserves file URI roots without treating the scheme separators as path separators", () => {
    expect(
      resourcePathCandidates("file:///home/user/folder/report.json").slice(
        0,
        3,
      ),
    ).toEqual([
      "file:///home/user/folder/report.json",
      "file:///home/…/folder/report.json",
      "…/folder/report.json",
    ]);
  });

  it("keeps a long filename and extension after directory segments are gone", () => {
    const candidates = resourcePathCandidates(
      "outputs/2026/long-analysis-observation-results.ipynb",
    );
    expect(candidates).toContain("long-analysis-observation-results.ipynb");
    expect(candidates).toContain("long-analysis-observation….ipynb");
  });

  it("selects the first projection that fits and responds to width changes", () => {
    let width = 250;
    let resize: () => void = () => undefined;
    class MockResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        resize = () =>
          this.callback(
            [{ target } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("resource-path") ? width : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("resource-path__measure")
          ? (this.textContent?.length ?? 0) * 7
          : 0;
      },
    );

    const path = "tests/browser/fixtures/file-previews/notebook.ipynb";
    const { container } = render(<ResourcePathLabel path={path} />);
    const label = container.querySelector(".resource-path");
    const visible = container.querySelector(".resource-path__visible");
    expect(label?.querySelector(".visually-hidden")).toHaveTextContent(path);
    expect(visible).toHaveAttribute("aria-hidden", "true");
    expect(visible).toHaveTextContent("…/file-previews/notebook.ipynb");

    width = 100;
    act(() => resize());
    expect(visible).toHaveTextContent("notebook.ipynb");
  });
});
