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

export function pendingContentFromInput(input: PendingInput): PendingContent {
  return {
    steering: input.steering.map((text) => ({ text })),
    followUp: input.followUp.map((text) => ({ text })),
  };
}

/** Only visible rows need previews. Totals include the full native and Host queues. */
export function projectPendingQueues(
  pi: PendingContent,
  host: readonly {
    message: string;
    behavior: NonNullable<PromptRequest["behavior"]>;
    imageCount: number | null;
  }[],
  previousRevision: number,
): PendingQueues {
  let remaining = MAX_PENDING_MESSAGES;
  const project = (
    native: PendingContentRow[],
    mode: NonNullable<PromptRequest["behavior"]>,
  ): PendingMessageSummary[] => {
    const rows = native
      .slice(0, remaining)
      .map(({ text, imageCount, imageAttachmentIds }, index) => ({
        // Coordinates in the unconsumed view, not native Pi item identities.
        id: `text-${mode}-${index}`,
        ...pendingTextSummary(text),
        ...(imageCount === undefined ? {} : { imageCount }),
        ...(imageAttachmentIds === undefined ? {} : { imageAttachmentIds }),
      }));
    remaining -= rows.length;
    const held = host
      .filter((item) => item.behavior === mode)
      .slice(0, remaining)
      .map(({ message, imageCount }, index) => ({
        id: `host-${mode}-${index}`,
        ...pendingTextSummary(message),
        ...(imageCount ? { imageCount } : {}),
      }));
    remaining -= held.length;
    return [...rows, ...held];
  };
  const steering = project(pi.steering, "steer");
  const followUp = project(pi.followUp, "followUp");
  const imageCount = (sum: number, row: { imageCount?: number | null }) =>
    sum + (row.imageCount ?? 0);
  const totalImageCount = host.some((row) => row.imageCount === null)
    ? undefined
    : pi.steering.reduce(imageCount, 0) +
      pi.followUp.reduce(imageCount, 0) +
      host.reduce(imageCount, 0);
  return {
    revision: previousRevision + 1,
    totalCount: pi.steering.length + pi.followUp.length + host.length,
    ...(totalImageCount === undefined ? {} : { totalImageCount }),
    steering,
    followUp,
  };
}
