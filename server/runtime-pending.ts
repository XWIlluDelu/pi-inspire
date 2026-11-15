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

type PendingMode = NonNullable<PromptRequest["behavior"]>;

export function* pendingRows<H extends { behavior: PendingMode }>(
  pi: PendingContent,
  host: readonly H[],
) {
  for (const [key, mode] of [
    ["steering", "steer"],
    ["followUp", "followUp"],
  ] as const) {
    // These are coordinates in the unconsumed view, not Pi item identities.
    for (const [index, native] of pi[key].entries())
      yield { key, id: `text-${mode}-${index}`, native, held: null };
    let index = 0;
    for (const held of host)
      if (held.behavior === mode)
        yield { key, id: `host-${mode}-${index++}`, native: null, held };
  }
}

/** Only visible rows need previews. Totals include the full native and Host queues. */
export function projectPendingQueues(
  pi: PendingContent,
  host: readonly {
    message: string;
    behavior: PendingMode;
    imageCount: number | null;
  }[],
  previousRevision: number,
): PendingQueues {
  let remaining = MAX_PENDING_MESSAGES;
  const groups: Record<keyof PendingContent, PendingMessageSummary[]> = {
    steering: [],
    followUp: [],
  };
  for (const { key, id, native, held } of pendingRows(pi, host)) {
    if (remaining-- === 0) break;
    const imageCount = native ? native.imageCount : held?.imageCount || undefined;
    groups[key].push({
      id,
      ...pendingTextSummary(native ? native.text : held!.message),
      ...(imageCount === undefined ? {} : { imageCount }),
      ...(native?.imageAttachmentIds === undefined
        ? {}
        : { imageAttachmentIds: native.imageAttachmentIds }),
    });
  }
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
    ...groups,
  };
}
