import {
  MAX_PENDING_MESSAGES,
  type PendingInput,
  type PendingMessageSummary,
  type PendingQueues,
  type PromptRequest,
} from "../shared/contracts.js";
import { pendingTextSummary } from "../shared/pending-preview.js";

export interface PendingContentRow {
  text: string;
  imageCount?: number;
  imageAttachmentIds?: string[];
}
export interface PendingContent {
  steering: PendingContentRow[];
  followUp: PendingContentRow[];
}

export function exactPendingInput(value: unknown): PendingInput | null {
  if (!value || typeof value !== "object") return null;
  const { steering, followUp } = value as Record<string, unknown>;
  if (
    !Array.isArray(steering) ||
    !Array.isArray(followUp) ||
    !steering.every((text) => typeof text === "string") ||
    !followUp.every((text) => typeof text === "string")
  )
    return null;
  return { steering: [...steering], followUp: [...followUp] };
}

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
        ...pendingTextSummary(item.message),
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

export function pendingContentFromTexts(
  steeringTexts: unknown,
  followUpTexts: unknown,
): PendingContent {
  const rows = (values: unknown): PendingContentRow[] =>
    Array.isArray(values)
      ? values
          .filter((text): text is string => typeof text === "string")
          .map((text) => ({ text }))
      : [];
  return { steering: rows(steeringTexts), followUp: rows(followUpTexts) };
}

export function pendingQueuesFromContent(
  content: PendingContent,
  previousRevision: number,
): PendingQueues {
  let remaining = MAX_PENDING_MESSAGES;
  const project = (rows: PendingContentRow[], kind: string) => {
    const summaries: PendingMessageSummary[] = [];
    for (const { text, imageCount, imageAttachmentIds } of rows) {
      if (remaining === 0) break;
      remaining -= 1;
      summaries.push({
        // Coordinates in the unconsumed view, not native Pi item identities.
        id: `text-${kind}-${summaries.length}`,
        ...pendingTextSummary(text),
        ...(imageCount === undefined ? {} : { imageCount }),
        ...(imageAttachmentIds === undefined ? {} : { imageAttachmentIds }),
      });
    }
    return summaries;
  };
  const steering = project(content.steering, "steer");
  const followUp = project(content.followUp, "followUp");
  return {
    revision: previousRevision + 1,
    totalCount: content.steering.length + content.followUp.length,
    steering,
    followUp,
  };
}

export function pendingQueuesFromTexts(
  steeringTexts: unknown,
  followUpTexts: unknown,
  previousRevision: number,
): PendingQueues {
  return pendingQueuesFromContent(
    pendingContentFromTexts(steeringTexts, followUpTexts),
    previousRevision,
  );
}
