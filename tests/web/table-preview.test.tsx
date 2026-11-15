// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TablePreview } from "../../src/components/TablePreview";
import { delimiterForFile, parseDelimitedText } from "../../src/delimited-text";

const rows = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    );

describe("delimited table preview", () => {
  it("renders quoted CSV and cycles numeric sorting while keeping blank cells last", () => {
    const csv =
      '\uFEFFsample,note,latency_ms\r\n"Sample, A","said ""ok""\nthen left",12.4\r\nB,,2e1\r\nC,,9.5\r\nD\r\n';
    const name = "results/fit_params.CSV";
    render(
      <TablePreview
        text={csv}
        delimiter={delimiterForFile(name)!}
        name={name}
      />,
    );
    expect(rows()).toEqual([
      ["Sample, A", 'said "ok"\nthen left', "12.4"],
      ["B", "", "2e1"],
      ["C", "", "9.5"],
      ["D", "", ""],
    ]);
    const header = screen.getByRole("columnheader", { name: /latency_ms/ });
    const sort = within(header).getByRole("button");
    const latencies = () => rows().map((row) => row[2]);
    fireEvent.click(sort);
    expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(latencies()).toEqual(["9.5", "12.4", "2e1", ""]);
    fireEvent.click(sort);
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(latencies()).toEqual(["2e1", "12.4", "9.5", ""]);
    fireEvent.click(sort);
    expect(header).toHaveAttribute("aria-sort", "none");
    expect(latencies()).toEqual(["12.4", "2e1", "9.5", ""]);
  });

  it("withholds an incomplete TSV record and tells the reader where to get the rest", () => {
    const name = "runs.tsv";
    render(
      <TablePreview
        text={"a\tb\n1\t2\n3\t4\n5\t"}
        delimiter={delimiterForFile(name)!}
        name={name}
        truncated
      />,
    );
    expect(rows()).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing the first 2 rows. See the rest in Source or Download.",
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

  it("distinguishes exactly enough rows from an omitted narrow-table suffix", () => {
    const text = "x\n1\n2\n3";
    expect(parseDelimitedText(text, ",", { maxRows: 3 }).omittedRows).toBe(
      false,
    );
    expect(parseDelimitedText(`${text}\n4`, ",", { maxRows: 3 })).toMatchObject(
      {
        rows: [["1"], ["2"], ["3"]],
        omittedRows: true,
      },
    );
    expect(delimiterForFile("notes.md")).toBeNull();
  });
});
