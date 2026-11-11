import { describe, expect, it } from "vitest";
import {
  delimiterForFile,
  numericColumns,
  parseDelimitedText,
} from "../../src/delimited-text";

describe("delimited text", () => {
  it("recognises CSV and TSV names only", () => {
    expect(delimiterForFile("results/fit_params.CSV")).toBe(",");
    expect(delimiterForFile("runs.tsv")).toBe("\t");
    expect(delimiterForFile("notes.md")).toBeNull();
  });

  it("parses quotes, doubled quotes, embedded breaks, CRLF and a BOM", () => {
    const table = parseDelimitedText(
      '﻿name,note,value\r\n"Sample, A","said ""ok""\nthen left",12.4\r\nB,,18.2\r\n',
      ",",
    );
    expect(table.header).toEqual(["name", "note", "value"]);
    expect(table.rows).toEqual([
      ["Sample, A", 'said "ok"\nthen left', "12.4"],
      ["B", "", "18.2"],
    ]);
    expect(table.omittedRows).toBe(false);
  });

  it("drops a possibly partial final record from a truncated transfer", () => {
    const table = parseDelimitedText("a\tb\n1\t2\n3\t4\n5\t", "\t", {
      truncated: true,
    });
    expect(table.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(table.omittedRows).toBe(true);
  });

  it("caps displayed rows and says so", () => {
    const text = ["x", ...Array.from({ length: 10 }, (_, i) => String(i))].join(
      "\n",
    );
    const table = parseDelimitedText(text, ",", { maxRows: 3 });
    expect(table.rows).toEqual([["0"], ["1"], ["2"]]);
    expect(table.omittedRows).toBe(true);
    expect(
      parseDelimitedText("x\n1\n2\n3", ",", { maxRows: 3 }).omittedRows,
    ).toBe(false);
  });

  it("pads ragged rows through the column count and detects numeric columns", () => {
    const table = parseDelimitedText(
      "run,ms,flag,extra\n1,12.4,yes\n2,1e-3,no,x\n3,NaN,yes",
      ",",
    );
    expect(table.columns).toBe(4);
    expect(numericColumns(table)).toEqual([true, true, false, false]);
  });
});
