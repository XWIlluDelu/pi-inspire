import {
  MAX_PENDING_MESSAGES,
  MAX_PENDING_PREVIEW_CHARS,
  type PromptRequest,
  type PendingMessageSummary,
  type PendingQueues,
} from "../shared/contracts.js";

export function mergePendingQueues(
  pi: PendingQueues,
  host: readonly Pick<PromptRequest, "message" | "behavior">[],
  previousRevision: number,
): PendingQueues {
  const summarize = (mode: NonNullable<PromptRequest["behavior"]>) =>
    host
      .filter((item) => item.behavior === mode)
      .map((item, index) => ({
        id: `host-${mode}-${index}`,
        textPreview: item.message.slice(0, MAX_PENDING_PREVIEW_CHARS),
        textLength: item.message.length,
        textTruncated: item.message.length > MAX_PENDING_PREVIEW_CHARS,
      }));
  const steering = [...pi.steering, ...summarize("steer")];
  const followUp = [...pi.followUp, ...summarize("followUp")];
  const remaining = MAX_PENDING_MESSAGES;
  return {
    revision: previousRevision + 1,
    totalCount: pi.totalCount + host.length,
    steering: steering.slice(0, remaining),
    followUp: followUp.slice(0, Math.max(0, remaining - steering.length)),
  };
}

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
