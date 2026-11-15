import { Package } from "lucide-react";
import { memo, useId } from "react";
import type { ChatMessage } from "../events";
import { messageCopyLoader } from "../message-copy";
import { usePresentationAdapters } from "../presentation-adapters";
import { ImageGallery } from "./ImageGallery";
import { messageImage } from "./ImagePreview";
import { ProgressiveRichText as RichText } from "./ProgressiveRichText";
import {
  ActivityDetails,
  ActivityHeader,
  ActivityText,
} from "./transcript-activity-visibility";

function inspect(value: unknown): string {
  return typeof value === "string"
    ? value
    : (JSON.stringify(value, null, 2) ?? String(value));
}

/** Extension-authored context, not a tool execution or a user-authored turn. */
export const CustomMessage = memo(function CustomMessage({
  message,
  sessionId,
  viewId,
  projectionKey,
}: {
  message: ChatMessage;
  sessionId: string;
  viewId: string;
  projectionKey: string;
}) {
  const titleId = useId();
  const { customMessages } = usePresentationAdapters();
  if (message.display === false) return null;
  const type =
    (typeof message.customType === "string" &&
      message.customType.trim().slice(0, 80)) ||
    "custom";
  const presentation = customMessages.resolve(message);
  const title =
    presentation?.title ??
    (type === "custom"
      ? "Extension message"
      : type
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .replace(/[-_:]+/g, " ")
          .replace(/^./, (character) => character.toUpperCase()));
  const hasDetails = message.details !== undefined && message.details !== null;
  const owner = { sessionId, viewId, projectionKey };
  const { content } = message;
  const parts = Array.isArray(content)
    ? content
    : content == null
      ? []
      : [
          typeof content === "string"
            ? { type: "text", text: content }
            : content,
        ];
  const copyText = (source = message) => {
    const parts = [
      title,
      `Type: ${source.customType ?? type}`,
      "Content",
      inspect(source.content ?? []),
    ];
    if (source.details !== undefined && source.details !== null)
      parts.push("Details", inspect(source.details));
    return parts.join("\n\n");
  };

  return (
    <article
      className="activity-surface custom-message"
      aria-labelledby={titleId}
    >
      <ActivityHeader
        className="custom-message__head"
        icon={<Package size={14} aria-hidden />}
        copy={{
          getContent: messageCopyLoader(message, copyText, owner),
          label: `${title} block`,
          className: "custom-message__copy",
        }}
      >
        <div className="custom-message__identity">
          <span id={titleId} className="custom-message__title">
            {title}
          </span>
          {presentation ? (
            <span className="custom-message__source">
              {presentation.source}
            </span>
          ) : null}
        </div>
      </ActivityHeader>
      <ImageGallery>
        <div className="custom-message__body">
          {parts.map((part: unknown, index) => {
            const item =
              part && typeof part === "object"
                ? (part as Record<string, unknown>)
                : null;
            if (item?.type === "text" && typeof item.text === "string")
              return (
                <RichText
                  key={index}
                  text={presentation?.body ?? item.text}
                  variant="user"
                />
              );
            return (
              (Array.isArray(content) &&
                messageImage(
                  part,
                  message.__inspireMessageIndex,
                  index,
                  owner,
                  message.__inspireSavedHistory
                    ? message.__inspireEntryId
                    : undefined,
                )) || (
                <ActivityText
                  key={index}
                  label="Extension content"
                  text={inspect(part)}
                />
              )
            );
          })}
        </div>
      </ImageGallery>
      {hasDetails || presentation ? (
        <ActivityDetails
          reader="custom-details"
          label="Details"
          className="custom-message__details"
        >
          {() => (
            <ActivityText
              label="Extension details"
              text={inspect({
                customType: message.customType,
                ...(presentation && { content }),
                details: message.details,
              })}
            />
          )}
        </ActivityDetails>
      ) : null}
    </article>
  );
});
