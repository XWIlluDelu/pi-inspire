import {
  type PendingMessageSummary,
  type PendingQueues,
} from "../../shared/contracts";

let nextPendingId = 0;

export function pendingMessage(
  text: string,
  overrides: Partial<PendingMessageSummary> = {},
): PendingMessageSummary {
  return {
    id: `pending-${++nextPendingId}`,
    textPreview: text,
    textLength: text.length,
    textTruncated: false,
    imageCount: 0,
    nonTextContentCount: 0,
    ...overrides,
  };
}

export function pendingQueues(
  steering: string[] = [],
  followUp: string[] = [],
  overrides: Partial<PendingQueues> = {},
): PendingQueues {
  return {
    managementAvailable: false,
    paused: false,
    revision: 0,
    steering: steering.map((text) => pendingMessage(text)),
    followUp: followUp.map((text) => pendingMessage(text)),
    ...overrides,
  };
}
