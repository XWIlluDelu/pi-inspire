import { createHash } from "node:crypto";

export interface UserMessageEvidence {
  identity: string;
  fingerprint: string;
  textFingerprint: string;
  imageCount: number;
}

export function pendingImageHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The worker can corroborate consumption without serializing image bodies. */
export function userMessageEvidence(
  value: unknown,
): UserMessageEvidence | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.role !== "user") return null;
  const content = Array.isArray(message.content) ? message.content : [];
  const text =
    typeof message.content === "string"
      ? message.content
      : content
          .filter((part) => part?.type === "text")
          .map((part) => part.text)
          .join("");
  const images = content.filter((part) => part?.type === "image");
  return {
    identity: pendingImageHash([text, images, message.timestamp]),
    fingerprint: pendingImageHash([text, images]),
    textFingerprint: pendingImageHash(text),
    imageCount: images.length,
  };
}
