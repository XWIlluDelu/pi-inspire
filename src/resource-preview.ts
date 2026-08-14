import type {
  ResourceDescriptor,
  ResourceProbeResult,
} from "../shared/contracts";
import { ApiError } from "./api";

/** Text-like previews are range-capped; a body shorter than the file's
 * size marks the preview truncated. */
export const TEXT_PREVIEW_BYTES = 256 * 1024;
/** Blob-backed image/PDF/audio/video previews must fit in browser memory.
 * Fetch one sentinel byte beyond the limit so a same-inode file growth cannot
 * masquerade as a complete preview. */
export const MAX_MEDIA_PREVIEW_BYTES = 32 * 1024 * 1024;

/** In-document CSP injected into sandboxed HTML previews: no scripts (the
 * iframe sandbox enforces that too), no remote subresources. */
const HTML_PREVIEW_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'";

export type ResourcePreview =
  | { status: "loading"; reference: string }
  | { status: "error"; reference: string; message: string }
  /** A bare reference the host refused to guess about: the candidates it
   * found are offered for the user to choose. */
  | {
      status: "ambiguous";
      reference: string;
      message: string;
      matches: string[];
    }
  | {
      status: "ready";
      reference: string;
      descriptor: ResourceDescriptor;
      /** Decoded text for text/markdown/html previews. */
      text?: string;
      truncated?: boolean;
      /** Object URL for binary-backed previews (image/pdf/audio/video/html). */
      objectUrl?: string;
      /** The descriptor remains inspectable even when its bytes are withheld. */
      contentUnavailable?: "too-large";
    };

export function injectHtmlPreviewCsp(html: string): string {
  // Sandbox blocks script execution and privilege; the injected CSP removes
  // network reach and navigation primitives. Parse rather than regex-splice:
  // a fake "<head>" inside a comment must not choose the injection point.
  // parseFromString is inert — nothing loads or executes during parsing.
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const element of [...parsed.querySelectorAll("base")]) element.remove();
  for (const element of [...parsed.querySelectorAll("meta[http-equiv]")]) {
    if (/^refresh$/i.test(element.getAttribute("http-equiv") ?? ""))
      element.remove();
  }
  const meta = parsed.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", HTML_PREVIEW_CSP);
  parsed.head.insertBefore(meta, parsed.head.firstChild);
  return `<!DOCTYPE html>${parsed.documentElement.outerHTML}`;
}

export function classifiedResourceFailure(
  reference: string,
  error: unknown,
): ResourceProbeResult | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 409 && error.matches) {
    return {
      reference,
      availability: "ambiguous",
      message: error.message,
      matches: error.matches,
    };
  }
  if (error.status === 404)
    return { reference, availability: "missing", message: error.message };
  if (error.status === 403)
    return { reference, availability: "unavailable", message: error.message };
  if (error.status === 400)
    return { reference, availability: "invalid", message: error.message };
  return null;
}

export function unknownResourceAvailability(
  reference: string,
  error?: unknown,
): ResourceProbeResult {
  const message =
    error instanceof Error && error.message
      ? `Availability could not be checked: ${error.message}`
      : "Availability could not be checked. Retry to verify this reference.";
  return { reference, availability: "unknown", message };
}
