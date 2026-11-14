import { Package } from "lucide-react";
import { memo, useId, useState } from "react";
import { type ChatMessage, messageText } from "../events";
import { messageCopyLoader } from "../message-copy";
import { usePresentationAdapters } from "../presentation-adapters";
import { CodeView } from "./CodeView";
import { CopyAction } from "./CopyAction";
import { DetailSummary } from "./DetailSummary";
import { ImageGallery } from "./ImageGallery";
import { ImagePreview, TranscriptImage } from "./ImagePreview";
import { ProgressiveRichText as RichText } from "./ProgressiveRichText";

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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const type =
    (typeof message.customType === "string" &&
      message.customType.trim().slice(0, 80)) ||
    "custom";
  const { customMessages } = usePresentationAdapters();
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
  const text = messageText(message);
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

  if (message.display === false) return null;
  return (
    <article className="turn turn--custom" aria-labelledby={titleId}>
      <div className="activity-surface custom-message">
        <div className="activity-surface__head custom-message__head">
          <Package size={14} aria-hidden />
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
          <CopyAction
            getContent={messageCopyLoader(message, copyText, {
              sessionId,
              viewId,
              projectionKey,
            })}
            label={`${title} block`}
            className="activity-copy custom-message__copy"
          />
        </div>
        <ImageGallery>
          <div className="custom-message__body">
            {typeof message.content === "string" ? (
              <RichText text={presentation?.body ?? text} variant="user" />
            ) : Array.isArray(message.content) ? (
              message.content.map((part: unknown, index: number) => {
                const item =
                  part && typeof part === "object"
                    ? (part as Record<string, unknown>)
                    : null;
                if (item?.type === "text" && typeof item.text === "string") {
                  return (
                    <RichText key={index} text={item.text} variant="user" />
                  );
                }
                if (item?.type === "image") {
                  if (
                    Number.isSafeInteger(message.__inspireMessageIndex) &&
                    sessionId &&
                    viewId
                  ) {
                    return (
                      <TranscriptImage
                        key={index}
                        sessionId={sessionId}
                        viewId={viewId}
                        projectionKey={projectionKey}
                        reference={`pi-embedded://${message.__inspireMessageIndex}/${index}`}
                      />
                    );
                  }
                  if (
                    typeof item.data === "string" &&
                    typeof item.mimeType === "string" &&
                    /^image\//i.test(item.mimeType)
                  ) {
                    return (
                      <ImagePreview
                        key={index}
                        src={`data:${item.mimeType};base64,${item.data}`}
                        className="image-preview--message"
                      />
                    );
                  }
                }
                return (
                  <CodeView
                    key={index}
                    className="activity-reader"
                    tabIndex={0}
                  >
                    {inspect(part)}
                  </CodeView>
                );
              })
            ) : message.content != null ? (
              <CodeView className="activity-reader" tabIndex={0}>
                {inspect(message.content)}
              </CodeView>
            ) : null}
          </div>
        </ImageGallery>
        {hasDetails || presentation ? (
          <details className="custom-message__details" open={detailsOpen}>
            <DetailSummary
              onClick={(event) => {
                event.preventDefault();
                setDetailsOpen(!detailsOpen);
              }}
            >
              Details
            </DetailSummary>
            {detailsOpen ? (
              <CodeView className="activity-reader" tabIndex={0}>
                {inspect(
                  presentation
                    ? {
                        customType: message.customType,
                        content: message.content,
                        details: message.details,
                      }
                    : {
                        customType: message.customType,
                        details: message.details,
                      },
                )}
              </CodeView>
            ) : null}
          </details>
        ) : null}
      </div>
    </article>
  );
});
