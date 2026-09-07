import { Package } from "lucide-react";
import { memo, useId, useState } from "react";
import { type ChatMessage, messageText } from "../events";
import { CopyAction } from "./CopyAction";
import { ImagePreview, PersistedImage } from "./ImagePreview";
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
  const title =
    type === "custom"
      ? "Extension message"
      : type
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .replace(/[-_:]+/g, " ")
          .replace(/^./, (character) => character.toUpperCase());
  const hasDetails = message.details !== undefined && message.details !== null;
  const text = messageText(message);
  const copyText = [
    title,
    `Type: ${type}`,
    "Content",
    inspect(message.content ?? []),
  ];
  if (hasDetails) copyText.push("Details", inspect(message.details));

  if (message.display === false) return null;
  return (
    <article className="turn turn--custom" aria-labelledby={titleId}>
      <div className="custom-message">
        <div className="custom-message__head">
          <Package size={14} aria-hidden />
          <span id={titleId} className="custom-message__title">
            {title}
          </span>
          <code className="custom-message__type">{type}</code>
          <CopyAction
            text={copyText.join("\n\n")}
            label={`${title} block`}
            className="custom-message__copy"
          />
        </div>
        <div className="custom-message__body">
          {typeof message.content === "string" ? (
            <RichText text={text} variant="user" />
          ) : Array.isArray(message.content) ? (
            message.content.map((part: unknown, index: number) => {
              if (!part || typeof part !== "object") return null;
              const item = part as Record<string, unknown>;
              if (item.type === "text" && typeof item.text === "string") {
                return <RichText key={index} text={item.text} variant="user" />;
              }
              if (item.type === "image") {
                if (
                  Number.isSafeInteger(message.__inspireMessageIndex) &&
                  sessionId &&
                  viewId
                ) {
                  return (
                    <PersistedImage
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
                <pre key={index} className="custom-message__raw">
                  {inspect(part)}
                </pre>
              );
            })
          ) : message.content != null ? (
            <pre className="custom-message__raw">
              {inspect(message.content)}
            </pre>
          ) : null}
        </div>
        {hasDetails ? (
          <details className="custom-message__details" open={detailsOpen}>
            <summary
              onClick={(event) => {
                event.preventDefault();
                setDetailsOpen(!detailsOpen);
              }}
            >
              Details
            </summary>
            {detailsOpen ? (
              <pre className="custom-message__raw">
                {inspect(message.details)}
              </pre>
            ) : null}
          </details>
        ) : null}
      </div>
    </article>
  );
});
