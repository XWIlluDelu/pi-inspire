import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_PROMPT_IMAGE_BYTES,
} from "../shared/contracts";

interface StagedAttachmentSize {
  size: number;
  kind: "image" | "file";
}

function isImage(value: StagedAttachmentSize | File): boolean {
  return "kind" in value
    ? value.kind === "image"
    : /^image\//iu.test(value.type);
}

function limitLabel(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}

export function selectAttachmentFiles(
  existing: readonly StagedAttachmentSize[],
  candidates: readonly File[],
): { accepted: File[]; warning: string | null } {
  let count = existing.length;
  let totalBytes = existing.reduce((sum, item) => sum + item.size, 0);
  let imageBytes = existing.reduce(
    (sum, item) => sum + (isImage(item) ? item.size : 0),
    0,
  );
  const accepted: File[] = [];
  let warning: string | null = null;

  for (const file of candidates) {
    const image = isImage(file);
    if (count >= MAX_ATTACHMENTS) {
      warning ??= `At most ${MAX_ATTACHMENTS} attachments per message`;
      continue;
    }
    if (file.size > MAX_ATTACHMENT_FILE_BYTES) {
      warning ??= `Each attachment must be at most ${limitLabel(MAX_ATTACHMENT_FILE_BYTES)}`;
      continue;
    }
    if (totalBytes + file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
      warning ??= `Attachments per message must total at most ${limitLabel(MAX_ATTACHMENT_UPLOAD_BYTES)}`;
      continue;
    }
    if (image && imageBytes + file.size > MAX_PROMPT_IMAGE_BYTES) {
      warning ??= `Images per message must total at most ${limitLabel(MAX_PROMPT_IMAGE_BYTES)}`;
      continue;
    }
    accepted.push(file);
    count += 1;
    totalBytes += file.size;
    if (image) imageBytes += file.size;
  }

  return { accepted, warning };
}
