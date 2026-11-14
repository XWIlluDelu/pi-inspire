export type ReceiptStorageIssue = "format" | "storage";

type ReceiptRead<T> =
  | { value: T; issue?: undefined }
  | { value?: undefined; issue: ReceiptStorageIssue; error: unknown };

/** Each executor supplies its schema, size limit and empty record. */
export function receiptStorage<T>(
  maxChars: number,
  parse: (value: unknown) => T,
  empty: T,
  storage: () => Storage = () => window.sessionStorage,
) {
  function read(key: string): ReceiptRead<T> {
    let raw: string | null;
    try {
      raw = storage().getItem(key);
    } catch (error) {
      return { issue: "storage", error };
    }
    try {
      if (raw === null) return { value: empty };
      if (raw.length > maxChars)
        throw new Error("Receipt storage exceeds its limit");
      return { value: parse(JSON.parse(raw)) };
    } catch (error) {
      return { issue: "format", error };
    }
  }

  function write(key: string, value: T | null): void {
    const target = storage();
    if (value === null) target.removeItem(key);
    else target.setItem(key, JSON.stringify(value));
  }
  return { read, write };
}
