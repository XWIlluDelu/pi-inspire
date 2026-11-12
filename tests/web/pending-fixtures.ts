import {
  type PendingMessageSummary,
  type PendingQueues,
} from "../../shared/contracts";

let nextPendingId = 0;

function pendingMessage(text: string): PendingMessageSummary {
  return {
    id: `pending-${++nextPendingId}`,
    textPreview: text,
    textLength: text.length,
    textTruncated: false,
  };
}

export function pendingQueues(
  steering: string[] = [],
  followUp: string[] = [],
  overrides: Partial<PendingQueues> = {},
): PendingQueues {
  return {
    totalCount: steering.length + followUp.length,
    revision: 0,
    steering: steering.map((text) => pendingMessage(text)),
    followUp: followUp.map((text) => pendingMessage(text)),
    ...overrides,
  };
}
