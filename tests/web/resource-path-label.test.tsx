// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResourcePathLabel } from "../../src/components/ResourcePathLabel";

describe("ResourcePathLabel", () => {
  it("keeps the exact path available while CSS owns visual truncation", () => {
    const path = "tests/browser/fixtures/file-previews/notebook.ipynb";
    const { container } = render(
      <ResourcePathLabel path={path} className="test-path" />,
    );
    const label = container.querySelector(".resource-path");

    expect(label).toHaveClass("test-path");
    expect(label).toHaveAttribute("title", path);
    expect(label?.querySelector(".resource-path__visible")).toHaveTextContent(
      path,
    );
    expect(label?.querySelector(".resource-path__visible")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(label?.querySelector(".visually-hidden")).toHaveTextContent(path);
  });
});
