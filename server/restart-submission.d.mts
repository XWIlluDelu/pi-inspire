export type RestartSubmission =
  | { kind: "issued" }
  | { kind: "unconfirmed"; reason?: "release-unconfirmed" }
  | { kind: "not-issued"; reason: string; error?: unknown };

export function submitRestart(
  prepare: () => string | undefined | Promise<string | undefined>,
  issue: () => boolean | undefined | Promise<boolean | undefined>,
): Promise<RestartSubmission>;

export function settleRestart(
  result: RestartSubmission,
  release: () => boolean | Promise<boolean>,
): Promise<RestartSubmission>;
