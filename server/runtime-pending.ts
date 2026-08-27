import {
  MAX_PENDING_MESSAGES,
  MAX_PENDING_PREVIEW_CHARS,
  type PendingMessageSummary,
  type PendingQueues,
} from "../shared/contracts.js";

export const MAX_PENDING_TEXT_RESPONSE_BYTES = 4 * 1024 * 1024;

function pendingMessageSummary(value: unknown): PendingMessageSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    record.id.length > 128 ||
    typeof record.textPreview !== "string" ||
    record.textPreview.length > MAX_PENDING_PREVIEW_CHARS ||
    typeof record.textLength !== "number" ||
    !Number.isSafeInteger(record.textLength) ||
    record.textLength < record.textPreview.length ||
    typeof record.textTruncated !== "boolean" ||
    record.textTruncated !== record.textLength > record.textPreview.length ||
    typeof record.imageCount !== "number" ||
    !Number.isSafeInteger(record.imageCount) ||
    record.imageCount < 0 ||
    typeof record.nonTextContentCount !== "number" ||
    !Number.isSafeInteger(record.nonTextContentCount) ||
    record.nonTextContentCount < record.imageCount
  ) {
    return null;
  }
  return {
    id: record.id,
    textPreview: record.textPreview,
    textLength: record.textLength,
    textTruncated: record.textTruncated,
    imageCount: record.imageCount,
    nonTextContentCount: record.nonTextContentCount,
  };
}

export function pendingQueuesFromRecord(
  value: unknown,
  legacySteering: unknown,
  legacyFollowUp: unknown,
  previousRevision: number,
): PendingQueues {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const steering = Array.isArray(record.steering)
      ? record.steering.map(pendingMessageSummary)
      : [];
    const followUp = Array.isArray(record.followUp)
      ? record.followUp.map(pendingMessageSummary)
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

  const legacy = (
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
        id: `legacy-${kind}-${index}`,
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
  const steering = legacy(legacySteering, "steer", MAX_PENDING_MESSAGES);
  return {
    managementAvailable: false,
    paused: false,
    revision: previousRevision + 1,
    steering,
    followUp: legacy(
      legacyFollowUp,
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
