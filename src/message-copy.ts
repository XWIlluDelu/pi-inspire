import {
  type CopyContent,
  type CopyLoader,
  copyLoader,
  imageSourceBlob,
} from "./content-copy";
import type { ChatMessage } from "./events";
import { store } from "./store";

interface ImageOwner {
  sessionId: string;
  viewId: string;
  projectionKey: string;
}

/** Declare formats synchronously; image data still comes from Host authority. */
export function messageCopyLoader(
  message: ChatMessage | undefined,
  text: string | (() => string | Promise<string>),
  owner: ImageOwner | null,
): CopyLoader {
  const image =
    Array.isArray(message?.content) &&
    message.content.some(
      (part) => part && typeof part === "object" && part.type === "image",
    );
  return copyLoader(
    async (signal) =>
      messageCopyContent(
        message,
        typeof text === "function" ? await text() : text,
        owner,
        signal,
      ),
    { text: typeof text === "function" || Boolean(text) || !image, image },
  );
}

/** Resolve saved coordinates through the Host, never from projected image data.
 * Inline data is used only for messages without saved coordinates. */
export async function messageCopyContent(
  message: ChatMessage | undefined,
  text: string,
  owner: ImageOwner | null,
  signal: AbortSignal,
): Promise<CopyContent> {
  const images: Blob[] = [];
  if (Array.isArray(message?.content)) {
    for (const [index, part] of message.content.entries()) {
      if (!part || typeof part !== "object" || part.type !== "image") continue;
      if (Number.isSafeInteger(message.__inspireMessageIndex)) {
        if (!owner) throw new Error("The image's conversation is unavailable");
        images.push(
          await store.loadEmbeddedImage(
            owner.sessionId,
            owner.viewId,
            owner.projectionKey,
            `pi-embedded://${message.__inspireMessageIndex}/${index}`,
            signal,
          ),
        );
      } else {
        if (typeof part.data !== "string" || typeof part.mimeType !== "string")
          throw new Error("Image data is unavailable");
        images.push(
          await imageSourceBlob(
            `data:${part.mimeType};base64,${part.data}`,
            signal,
          ),
        );
      }
    }
  }
  return { text, images };
}
