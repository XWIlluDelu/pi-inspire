import {
  MAX_PENDING_MESSAGES,
  MAX_PENDING_PREVIEW_CHARS,
  type PendingMessageSummary,
  type PendingQueues,
} from "../shared/contracts.js";

export function pendingQueuesFromTexts(
  steeringTexts: unknown,
  followUpTexts: unknown,
  previousRevision: number,
): PendingQueues {
  let totalCount = 0;
  let remaining = MAX_PENDING_MESSAGES;
  const project = (values: unknown, kind: string) => {
    const summaries: PendingMessageSummary[] = [];
    if (!Array.isArray(values)) return summaries;
    for (const text of values) {
      if (typeof text !== "string") continue;
      totalCount += 1;
      if (remaining === 0) continue;
      remaining -= 1;
      summaries.push({
        // Presentation coordinates only: public Pi supplies no item identity.
        id: `text-${kind}-${summaries.length}`,
        textPreview: text.slice(0, MAX_PENDING_PREVIEW_CHARS),
        textLength: text.length,
        textTruncated: text.length > MAX_PENDING_PREVIEW_CHARS,
      });
    }
    return summaries;
  };
  const steering = project(steeringTexts, "steer");
  const followUp = project(followUpTexts, "followUp");
  return { revision: previousRevision + 1, totalCount, steering, followUp };
}
