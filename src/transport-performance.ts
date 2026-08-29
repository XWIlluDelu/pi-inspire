const PREFIX = "inspire:";
const MAX_ENTRIES_PER_METRIC = 64;

export function transportNow(): number {
  return performance.now();
}

/** Records privacy-safe transport timings in the browser Performance timeline.
 * Support diagnostics can inspect `performance.getEntriesByType("measure")`
 * without enabling a second telemetry or persistence channel. */
export function recordTransportMeasure(
  name: string,
  startedAt: number,
  detail: Record<string, string | number | boolean | null>,
): void {
  if (typeof window === "undefined") return;
  const qualified = `${PREFIX}${name}`;
  try {
    if (
      performance.getEntriesByName(qualified, "measure").length >=
      MAX_ENTRIES_PER_METRIC
    )
      performance.clearMeasures(qualified);
    performance.measure(qualified, {
      start: startedAt,
      end: transportNow(),
      detail,
    });
  } catch {
    // Diagnostics must never affect transport behavior.
  }
}

export async function withTransportMeasure<T>(
  name: string,
  operation: () => Promise<T>,
  detail: Record<string, string | number | boolean | null> = {},
): Promise<T> {
  const startedAt = transportNow();
  let confirmed = false;
  try {
    const result = await operation();
    confirmed = true;
    return result;
  } finally {
    recordTransportMeasure(name, startedAt, { ...detail, confirmed });
  }
}
