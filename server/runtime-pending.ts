import {
  MAX_PENDING_MESSAGES,
  MAX_PENDING_PREVIEW_CHARS,
  type PendingMessageSummary,
  type PendingQueues,
  parsePendingMessageSummary,
} from "../shared/contracts.js";

export const MAX_PENDING_TEXT_RESPONSE_BYTES = 4 * 1024 * 1024;

export function pendingQueuesFromRecord(
  value: unknown,
  steeringTexts: unknown,
  followUpTexts: unknown,
  previousRevision: number,
): PendingQueues {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const steering = Array.isArray(record.steering)
      ? record.steering.map(parsePendingMessageSummary)
      : [];
    const followUp = Array.isArray(record.followUp)
      ? record.followUp.map(parsePendingMessageSummary)
      : [];
    if (
      typeof record.paused === "boolean" &&
      typeof record.revision === "number" &&
      Number.isSafeInteger(record.revision) &&
      record.revision >= 0 &&
      steering.length + followUp.length <= MAX_PENDING_MESSAGES &&
      steering.every((item): item is PendingMessageSummary => item !== null) &&
      followUp.every((item): item is PendingMessageSummary => item !== null) &&
      new Set([...steering, ...followUp].map((item) => item?.id)).size ===
        steering.length + followUp.length
    ) {
      return {
        managementAvailable: true,
        paused: record.paused,
        revision: record.revision,
        steering,
        followUp,
      };
    }
  }

  const projectTextQueue = (
    values: unknown,
    kind: "steer" | "followUp",
    limit: number,
  ) => {
    const summaries: PendingMessageSummary[] = [];
    if (!Array.isArray(values) || limit <= 0) return summaries;
    for (const text of values) {
      if (typeof text !== "string") continue;
      const index = summaries.length;
      summaries.push({
        id: `text-${kind}-${index}`,
        textPreview: text.slice(0, MAX_PENDING_PREVIEW_CHARS),
        textLength: text.length,
        textTruncated: text.length > MAX_PENDING_PREVIEW_CHARS,
        imageCount: 0,
        nonTextContentCount: 0,
      });
      if (summaries.length === limit) break;
    }
    return summaries;
  };
  const steering = projectTextQueue(
    steeringTexts,
    "steer",
    MAX_PENDING_MESSAGES,
  );
  return {
    managementAvailable: false,
    paused: false,
    revision: previousRevision + 1,
    steering,
    followUp: projectTextQueue(
      followUpTexts,
      "followUp",
      MAX_PENDING_MESSAGES - steering.length,
    ),
  };
}

export function newestPendingQueues(
  current: PendingQueues,
  candidate: PendingQueues,
): PendingQueues {
  if (
    current.managementAvailable &&
    (!candidate.managementAvailable || candidate.revision < current.revision)
  ) {
    return current;
  }
  return candidate;
}
