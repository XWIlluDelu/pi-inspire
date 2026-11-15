/** Comma- and tab-separated files get a read-only table view beside Source. */
export function delimiterForFile(name: string): "," | "\t" | null {
  const basename = name.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (basename.endsWith(".csv")) return ",";
  if (basename.endsWith(".tsv") || basename.endsWith(".tab")) return "\t";
  return null;
}

interface DelimitedTable {
  header: string[];
  rows: string[][];
  /** Column count across header and rows; short rows are padded on display. */
  columns: number;
  /** Rows beyond the display cap, or a partial trailing record in a truncated
   * transfer, are withheld rather than shown as complete data. */
  omittedRows: boolean;
}

/**
 * RFC 4180-style parsing: quoted fields may contain delimiters, doubled quotes
 * and line breaks; CRLF and LF both end records. A truncated transfer drops its
 * final record because the cut may fall inside it.
 */
export function parseDelimitedText(
  text: string,
  delimiter: "," | "\t",
  options: { truncated?: boolean; maxRows?: number } = {},
): DelimitedTable {
  const maxRows = options.maxRows ?? 5_000;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  let stoppedEarly = false;
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const endRecord = () => {
    record.push(field);
    records.push(record);
    record = [];
    field = "";
    fieldStarted = false;
  };
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (quoted) {
      if (character !== '"') field += character;
      else if (body[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (character === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (character === delimiter) {
      record.push(field);
      field = "";
      fieldStarted = false;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && body[index + 1] === "\n") index += 1;
      endRecord();
      // Header plus maxRows data rows; anything after is withheld.
      if (records.length > maxRows) {
        stoppedEarly = index + 1 < body.length;
        break;
      }
    } else {
      field += character;
      fieldStarted = true;
    }
  }
  const unterminatedQuote = quoted;
  if (!stoppedEarly && (field !== "" || fieldStarted || record.length > 0))
    endRecord();
  let omittedRows = stoppedEarly || unterminatedQuote;
  if (options.truncated && records.length > 1) {
    records.pop();
    omittedRows = true;
  }
  const [header = [], ...rows] = records;
  const columns = Math.max(header.length, ...rows.map((row) => row.length), 0);
  return { header, rows, columns, omittedRows };
}

const NUMERIC = /^[-+]?(?:\d+(?:[.,]\d+)*(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?%?$/iu;

/** A column reads as numeric when every non-empty cell is a plain number. */
export function numericColumns(table: DelimitedTable): boolean[] {
  return Array.from({ length: table.columns }, (_, column) => {
    let seen = false;
    for (const row of table.rows) {
      const value = row[column]?.trim() ?? "";
      if (!value || /^(?:nan|na|null|-|—)$/iu.test(value)) continue;
      if (!NUMERIC.test(value)) return false;
      seen = true;
    }
    return seen;
  });
}

export function numericValue(value: string | undefined): number {
  const parsed = Number.parseFloat((value ?? "").replace(/,/gu, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
