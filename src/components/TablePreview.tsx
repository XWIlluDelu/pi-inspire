import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useState } from "react";
import {
  numericColumns,
  numericValue,
  parseDelimitedText,
} from "../delimited-text";

type Sort = { column: number; direction: "ascending" | "descending" } | null;
const MAX_PREVIEW_COLUMNS = 250;
const MAX_PREVIEW_CELLS = 20_000;

/** Read-only table view for CSV/TSV: sticky header, row numbers, numeric
 * alignment and click-to-sort. Source stays the exact, complete text view. */
export function TablePreview({
  text,
  delimiter,
  truncated,
  name,
}: {
  text: string;
  delimiter: "," | "\t";
  truncated?: boolean;
  name: string;
}) {
  const table = useMemo(() => {
    const parsed = parseDelimitedText(text, delimiter, { truncated });
    const columns = Math.min(parsed.columns, MAX_PREVIEW_COLUMNS);
    // Include the header row and the row-number column in the render budget.
    const rowLimit = Math.floor(MAX_PREVIEW_CELLS / (columns + 1)) - 1;
    const rows = parsed.rows.slice(0, rowLimit);
    return {
      ...parsed,
      columns,
      rows,
      omittedRows: parsed.omittedRows || rows.length < parsed.rows.length,
      omittedColumns: columns < parsed.columns,
    };
  }, [text, delimiter, truncated]);
  const numeric = useMemo(() => numericColumns(table), [table]);
  const [sort, setSort] = useState<Sort>(null);
  const order = useMemo(() => {
    const indices = table.rows.map((_, index) => index);
    if (!sort) return indices;
    const sign = sort.direction === "ascending" ? 1 : -1;
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    return indices.sort((left, right) => {
      const a = table.rows[left]![sort.column];
      const b = table.rows[right]![sort.column];
      if (numeric[sort.column]) {
        const x = numericValue(a);
        const y = numericValue(b);
        // Blank and non-numeric cells sink in both directions.
        if (Number.isNaN(x) || Number.isNaN(y))
          return Number.isNaN(x) === Number.isNaN(y)
            ? left - right
            : Number.isNaN(x)
              ? 1
              : -1;
        return (x - y) * sign || left - right;
      }
      return collator.compare(a ?? "", b ?? "") * sign || left - right;
    });
  }, [numeric, sort, table.rows]);

  if (table.columns === 0)
    return (
      <div className="table-preview table-preview--empty" role="status">
        Empty table
      </div>
    );

  const cycle = (column: number) =>
    setSort((current) =>
      current?.column !== column
        ? { column, direction: "ascending" }
        : current.direction === "ascending"
          ? { column, direction: "descending" }
          : null,
    );
  const previewLimits = [
    table.omittedRows ? `${table.rows.length.toLocaleString()} rows` : null,
    table.omittedColumns ? `${table.columns.toLocaleString()} columns` : null,
  ]
    .filter(Boolean)
    .join(" and ");

  return (
    <div
      className="res__preview-fill table-preview"
      data-pane-scroll-active="true"
    >
      {previewLimits ? (
        <div className="file-preview__notice" role="status">
          Showing the first {previewLimits}. See the rest in Source or Download.
        </div>
      ) : null}
      <table aria-label={name}>
        <thead>
          <tr>
            <th scope="col" className="table-preview__index">
              <span className="sr-only">Row</span>
            </th>
            {Array.from({ length: table.columns }, (_, column) => {
              const label = table.header[column] ?? "";
              const active = sort?.column === column ? sort.direction : null;
              return (
                <th
                  key={column}
                  scope="col"
                  aria-sort={active ?? "none"}
                  className={numeric[column] ? "table-preview__numeric" : ""}
                >
                  <button
                    type="button"
                    onClick={() => cycle(column)}
                    title={`Sort by ${label || `column ${column + 1}`}`}
                  >
                    <span>{label}</span>
                    {active === "ascending" ? (
                      <ArrowUp size={12} aria-hidden />
                    ) : active === "descending" ? (
                      <ArrowDown size={12} aria-hidden />
                    ) : null}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {order.map((rowIndex) => {
            const row = table.rows[rowIndex]!;
            return (
              <tr key={rowIndex}>
                <th scope="row" className="table-preview__index">
                  {rowIndex + 1}
                </th>
                {Array.from({ length: table.columns }, (_, column) => (
                  <td
                    key={column}
                    className={numeric[column] ? "table-preview__numeric" : ""}
                  >
                    {row[column] ?? ""}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
