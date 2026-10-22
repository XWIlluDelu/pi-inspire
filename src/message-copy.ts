import {
  type CopyContent,
  type CopyLoader,
  copyLoader,
  imageSourceBlob,
} from "./content-copy";
import { type ChatMessage, messageText } from "./events";
import { store } from "./store";
import { transcriptProjectionKey } from "./transcript-projection-key";

interface MessageOwner {
  sessionId: string;
  viewId: string;
  projectionKey: string;
}

/** Declare formats synchronously; saved content is read on demand from its entry. */
export function messageCopyLoader(
  message: ChatMessage | undefined,
  text: string | ((source?: ChatMessage) => string | Promise<string>),
  owner: MessageOwner | null,
): CopyLoader {
  const image =
    Array.isArray(message?.content) &&
    message.content.some(
      (part) => part && typeof part === "object" && part.type === "image",
    );
  return copyLoader(
    async (signal) => {
      if (
        message?.__inspireEntryId &&
        ["user", "assistant", "custom"].includes(message.role)
      ) {
        const current = () => {
          const state = store.getState();
          return (
            owner &&
            state.sessionId === owner.sessionId &&
            state.transcriptViewId === owner.viewId &&
            transcriptProjectionKey(
              state.transcriptViewId,
              state.transcriptIncarnation,
            ) === owner.projectionKey
          );
        };
        if (!current())
          throw new DOMException(
            "The message's conversation changed",
            "AbortError",
          );
        const content = await store.branchCopyContent(
          message.__inspireEntryId,
          signal,
          "message",
        );
        signal.throwIfAborted();
        if (!content || !current())
          throw new DOMException(
            "The message's conversation changed",
            "AbortError",
          );
        const source = JSON.parse(content.text) as ChatMessage;
        return {
          text:
            typeof text === "function"
              ? await text(source)
              : messageText(source),
          images: content.images,
        };
      }
      return messageCopyContent(
        message,
        typeof text === "function" ? await text(message) : text,
        owner,
        signal,
      );
    },
    { text: typeof text === "function" || Boolean(text) || !image, image },
  );
}

/** Resolve saved coordinates through the Host, never from projected image data.
 * Inline data is used only for messages without saved coordinates. */
export async function messageCopyContent(
  message: ChatMessage | undefined,
  text: string,
  owner: MessageOwner | null,
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
