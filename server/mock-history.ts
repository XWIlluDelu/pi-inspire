import { resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const HISTORY_FIXTURE_SESSION_ID = "mock-calibration-history";
const timestamp = "2026-10-01T10:00:00.000Z";
const historyImage = process.env.INSPIRE_MOCK_HISTORY_IMAGE
  ? {
      type: "image",
      mimeType: "image/png",
      data: process.env.INSPIRE_MOCK_HISTORY_IMAGE,
    }
  : {
      type: "image",
      mimeType: "image/gif",
      data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    };
const response = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: 1,
  provider: "fixture",
  model: "fixture",
  stopReason: "stop",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

/** One retained mock conversation, including a long old response, an alternate
 * route, and a tool-heavy current turn. Native semantics use isolated Pi tests. */
export function historyFixtureEntries(): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let parentId: string | null = null;
  const append = (id: string, message: Record<string, unknown>) => {
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp,
      message,
    } as unknown as SessionEntry);
    parentId = id;
  };
  for (let turn = 0; turn < 600; turn++) {
    append(`history-u-${turn}`, {
      role: "user",
      content:
        turn === 0
          ? [
              {
                type: "text",
                text: "Compare the calibration strategies and retain the full measurement record.",
              },
              historyImage,
            ]
          : `Review calibration run ${turn}: compare residuals and explain the next adjustment.`,
      timestamp: 1,
    });
    if (turn === 599) break;
    append(
      `history-a-${turn}`,
      response(
        turn === 0
          ? `# Original calibration record\n\n${"The reference measurement separates sensor drift from the calibration residual. Preserve the complete record for later comparisons.\n\n".repeat(550)}\nThe cobalt baseline is the complete old-history search marker.\n\n完整测量记录。`
          : `Run ${turn} keeps the reference measurement stable. Inspect the residual before changing the calibration.`,
      ),
    );
    if (turn === 598) {
      entries.push({
        type: "message",
        id: "history-alternate",
        parentId,
        timestamp,
        message: {
          role: "user",
          content:
            "Try the alternate calibration strategy with the amber reference.",
          timestamp: 1,
        },
      } as SessionEntry);
      entries.push({
        type: "message",
        id: "history-alternate-answer",
        parentId: "history-alternate",
        timestamp,
        message: response(
          "The amber reference is retained on this alternate route, not the current conversation.",
        ),
      } as SessionEntry);
    }
  }
  for (const excludeFromContext of [false, true]) {
    append(`history-shell-${excludeFromContext ? "excluded" : "included"}`, {
      role: "bashExecution",
      command: "printf 'native-shell-history'",
      output: excludeFromContext
        ? "native-shell-excluded-result"
        : "native shell line 2500\nCOMPLETE_NATIVE_SHELL_LOG_END\n",
      exitCode: 0,
      cancelled: false,
      truncated: !excludeFromContext,
      excludeFromContext,
      ...(!excludeFromContext
        ? {
            fullOutputPath: resolve(
              process.env.INSPIRE_MOCK_WORKSPACE ??
                "output/playwright/workspace",
              "native-shell.log",
            ),
          }
        : {}),
      timestamp: 1,
    });
  }
  for (let step = 0; step < 70; step++) {
    const id = `history-call-${step}`;
    append(`history-tool-call-${step}`, {
      ...response(`Inspect calibration artifact ${step}.`),
      content: [
        {
          type: "toolCall",
          id,
          name: "read",
          arguments: { path: `measurements/run-${step}.json` },
        },
      ],
    });
    append(`history-tool-result-${step}`, {
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [
        {
          type: "text",
          text: `Run ${step}: reference 1.000; residual ${(step / 10000).toFixed(4)}.`,
        },
      ],
      isError: false,
      timestamp: 1,
    });
  }
  append(
    "history-latest",
    response(
      "The current calibration run is complete. The reference remains stable across all inspected artifacts.",
    ),
  );
  return entries;
}

export function historyFixtureMessages(): unknown[] {
  return historyFixtureEntries()
    .filter(
      (entry) =>
        entry.type === "message" &&
        (entry.id === "history-u-599" ||
          entry.id === "history-latest" ||
          entry.id === "history-shell-included" ||
          entry.id === "history-shell-excluded" ||
          entry.id === "history-tool-call-69" ||
          entry.id === "history-tool-result-69"),
    )
    .map((entry) => ({
      ...(entry as Extract<SessionEntry, { type: "message" }>).message,
      entryId: entry.id,
      __inspireEntryId: entry.id,
      __inspireMessageId: `${entry.id}:0`,
    }));
}
