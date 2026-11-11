// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TablePreview } from "../../src/components/TablePreview";

const csv = "run,sample,latency_ms\n1,A,12.4\n2,B,18.2\n3,C,9.5\n4,D,\n";

const column = (index: number) =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[index]?.textContent);

describe("TablePreview", () => {
  it("aligns numeric columns and cycles sort ascending, descending, original", () => {
    render(<TablePreview text={csv} delimiter="," name="fit.csv" />);
    const header = screen.getByRole("columnheader", { name: /latency_ms/ });
    expect(header).toHaveClass("table-preview__numeric");
    const sort = within(header).getByRole("button");
    fireEvent.click(sort);
    expect(header).toHaveAttribute("aria-sort", "ascending");
    // Blank cells sink in either direction.
    expect(column(2)).toEqual(["9.5", "12.4", "18.2", ""]);
    fireEvent.click(sort);
    expect(column(2)).toEqual(["18.2", "12.4", "9.5", ""]);
    fireEvent.click(sort);
    expect(header).toHaveAttribute("aria-sort", "none");
    expect(column(1)).toEqual(["A", "B", "C", "D"]);
  });

  it("says when rows are withheld from a truncated transfer", () => {
    render(<TablePreview text={csv} delimiter="," name="fit.csv" truncated />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing the first 3 rows",
    );
  });

  it("bounds the rendered cells of a wide table, including padded cells", () => {
    const header = Array.from(
      { length: 300 },
      (_, index) => `col-${index}`,
    ).join(",");
    const { container } = render(
      <TablePreview
        text={`${header}\n${"1\n".repeat(100)}`}
        delimiter=","
        name="wide.csv"
      />,
    );
    expect(container.querySelectorAll("th, td").length).toBeLessThanOrEqual(
      20_000,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /Showing the first \d+ rows and 250 columns/,
    );
  });
});
