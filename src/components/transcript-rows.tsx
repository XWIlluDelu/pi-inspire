import {
  Archive,
  CornerUpLeft,
  GitFork,
  Image as ImageIcon,
  Package,
  Trash2,
  X,
} from "lucide-react";
import {
  memo,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
} from "react";
import type {
  GenericExtensionDisplay,
  PendingQueues,
  ToolVisibilityPreference,
  VisibilityPreference,
} from "../../shared/contracts";
import { type CopyLoader, type CopySource, copyLoader } from "../content-copy";
import {
  type ActivityTool,
  type ChatMessage,
  messageText,
  type ToolCallContent,
  userMessageDisplayContent,
  userMessageFileName,
} from "../events";
import { fileIconForPath } from "../file-icons";
import { messageCopyLoader } from "../message-copy";
import {
  checkpointPresentation,
  usePresentationAdapters,
} from "../presentation-adapters";
import { store } from "../store";
import { useImageUrl } from "../use-image-url";
import { hasActiveModal } from "../use-modal-focus";
import { CopyAction } from "./CopyAction";
import { ImageGallery } from "./ImageGallery";
import { ImagePreview, TranscriptImage } from "./ImagePreview";
import { PiLoader } from "./PiLoader";
import { ProgressiveRichText as RichText } from "./ProgressiveRichText";
import {
  CardHeader,
  GenericCard,
  type StaticVisibility,
  ThinkingCard,
  ToolCard,
  ToolResultCard,
} from "./transcript-cards";
import { TranscriptSearchReveal } from "./transcript-search";

// --- Turns and activity ---

function MessageActions({
  text,
  getContent,
  forkEntryId,
  copyLabel = "Message",
  className = "",
}: {
  text: string;
  getContent?: CopyLoader;
  forkEntryId?: string;
  copyLabel?: string;
  className?: string;
}) {
  const [forking, setForking] = useState(false);
  if (!text && !getContent && !forkEntryId) return null;
  return (
    <div className={`turn__actions ${className}`}>
      {text || getContent ? (
        <CopyAction
          text={text}
          getContent={getContent}
          label={copyLabel}
          className="turn__action"
        />
      ) : null}
      {forkEntryId ? (
        <button
          type="button"
          className="icon-button turn__action"
          aria-label="Fork session from this input"
          title="Fork a new session from this input"
          disabled={forking}
          onClick={() => {
            setForking(true);
            void store
              .forkFromEntry(forkEntryId)
              .finally(() => setForking(false));
          }}
        >
          {forking ? (
            <PiLoader size={13} aria-hidden />
          ) : (
            <GitFork size={13} aria-hidden />
          )}
        </button>
      ) : null}
    </div>
  );
}

export const UserBubble = memo(function UserBubble({
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
  const timestamp = message.timestamp;
  const sourceText = messageText(message);
  const { text, references } = userMessageDisplayContent(message);
  const images: Array<
    { key: string; reference: string } | { key: string; src: string }
  > = [];
  if (Array.isArray(message.content)) {
    message.content.forEach((part, partIndex) => {
      if (
        !part ||
        typeof part !== "object" ||
        (part as { type?: unknown }).type !== "image"
      )
        return;
      const image = part as { data?: unknown; mimeType?: unknown };
      if (
        Number.isSafeInteger(message.__inspireMessageIndex) &&
        sessionId &&
        viewId
      ) {
        images.push({
          key: `persisted:${partIndex}`,
          reference: `pi-embedded://${message.__inspireMessageIndex}/${partIndex}`,
        });
      } else if (
        typeof image.data === "string" &&
        typeof image.mimeType === "string" &&
        /^image\//i.test(image.mimeType)
      ) {
        images.push({
          key: `inline:${partIndex}`,
          src: `data:${image.mimeType};base64,${image.data}`,
        });
      }
    });
  }
  return (
    <div className="turn turn--user">
      <div
        className="user-bubble"
        title={
          timestamp != null ? new Date(timestamp).toLocaleString() : undefined
        }
      >
        {images.length > 0 ? (
          <ImageGallery>
            <div
              className="user-bubble__images"
              role="group"
              aria-label="Attached images"
            >
              {images.map((image) =>
                "reference" in image ? (
                  <TranscriptImage
                    key={image.key}
                    sessionId={sessionId}
                    viewId={viewId}
                    projectionKey={projectionKey}
                    reference={image.reference}
                  />
                ) : (
                  <ImagePreview
                    key={image.key}
                    src={image.src}
                    className="image-preview--message"
                  />
                ),
              )}
            </div>
          </ImageGallery>
        ) : null}
        {references.length > 0 ? (
          <ul className="user-bubble__files" aria-label="Referenced files">
            {references.map((path, index) => {
              const name = userMessageFileName(message, path);
              const FileIcon = fileIconForPath(name);
              return (
                <li
                  className="user-bubble__file"
                  key={`${index}:${path}`}
                  title={path}
                >
                  <FileIcon size={13} aria-hidden />
                  <span>{name}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {text ? <RichText text={text} variant="user" /> : null}
      </div>
      <MessageActions
        text={sourceText}
        getContent={
          sourceText || images.length
            ? messageCopyLoader(message, sourceText, {
                sessionId,
                viewId,
                projectionKey,
              })
            : undefined
        }
        forkEntryId={message.__inspireEntryId}
      />
    </div>
  );
});

function AssistantRow({
  streaming,
  children,
  actions,
}: {
  streaming: boolean;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className={`turn turn--assistant ${streaming ? "turn--streaming" : ""}`}
    >
      <div className="assistant-doc">{children}</div>
      {actions}
    </div>
  );
}

export function AssistantResponse({
  passages,
  streaming,
  copyText = "",
  copyContent,
}: {
  passages: readonly string[];
  streaming: boolean;
  copyText?: string;
  copyContent?: CopyLoader;
}) {
  return (
    <AssistantRow
      streaming={streaming}
      actions={
        <MessageActions
          text={copyText}
          getContent={copyContent}
          copyLabel="Response"
          className="turn__actions--response"
        />
      }
    >
      {passages.map((text, index) => (
        <RichText key={index} text={text} variant="assistant" />
      ))}
    </AssistantRow>
  );
}

export type AssistantActivityContent =
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      call: ToolCallContent;
      result: ChatMessage | undefined;
      activity?: ActivityTool;
    }
  | { kind: "generic"; item: object; title: string };

export function AssistantActivityCard({
  item,
  live,
  dynamicActive,
  thinkingVisibility,
  toolVisibility,
}: {
  item: AssistantActivityContent;
  live: boolean;
  dynamicActive: boolean;
  thinkingVisibility: VisibilityPreference;
  toolVisibility: ToolVisibilityPreference;
}) {
  const visibility = toolVisibility === "expanded" ? "expanded" : "collapsed";
  switch (item.kind) {
    case "thinking":
      return (
        <ThinkingCard
          text={item.text}
          visibility={thinkingVisibility}
          dynamicActive={dynamicActive}
        />
      );
    case "generic":
      return (
        <GenericCard
          item={item.item}
          title={item.title}
          visibility={visibility}
        />
      );
    case "tool":
      return (
        <ToolCard
          call={item.call}
          result={item.result}
          activity={item.activity}
          live={live}
          visibility={visibility}
          dynamic={toolVisibility === "dynamic"}
          dynamicActive={dynamicActive}
        />
      );
  }
}

export const UnpairedToolResultRow = memo(function UnpairedToolResultRow({
  message,
  visibility,
}: {
  message: ChatMessage;
  visibility: StaticVisibility;
}) {
  return <ToolResultCard result={message} visibility={visibility} />;
});

export const ContextCheckpointRow = memo(function ContextCheckpointRow({
  message,
}: {
  message: ChatMessage;
}) {
  const { configuration } = usePresentationAdapters();
  const {
    compacted,
    summary,
    displaySummary,
    title,
    tokensLabel,
    tokensDescription,
  } = checkpointPresentation(message, configuration);
  const tokens =
    compacted &&
    typeof message.tokensBefore === "number" &&
    Number.isFinite(message.tokensBefore)
      ? `${tokensLabel} ≈ ${Math.round(message.tokensBefore).toLocaleString()} tokens`
      : null;
  const [open, setOpen] = useState(false);
  const searchReveal = useContext(TranscriptSearchReveal);
  useLayoutEffect(() => {
    if (searchReveal !== null) setOpen(true);
  }, [searchReveal]);
  const bodyId = useId();
  const metricId = `${bodyId}-metric`;
  return (
    <div className="turn turn--checkpoint">
      <div className="context-checkpoint">
        <CardHeader
          expanded={open}
          icon={<Archive size={14} aria-hidden />}
          label={title}
          toggleLabel={title}
          accessibleLabel={title}
          controlsId={bodyId}
          describedBy={tokens ? metricId : undefined}
          onToggle={() => setOpen(!open)}
          summary={
            tokens && (
              <span
                id={metricId}
                className="context-checkpoint__metric"
                title={tokensDescription}
              >
                {tokens}
              </span>
            )
          }
          copyText={summary}
          copyLabel={compacted ? "Compaction summary" : "Branch summary"}
        />
        <div id={bodyId} className="card__body" hidden={!open}>
          {open ? (
            summary ? (
              <RichText text={displaySummary} />
            ) : (
              <p>No summary was recorded.</p>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
});

function PendingImage({ id, alt }: { id: string; alt: string }) {
  const loadImage = useCallback(
    (signal: AbortSignal) => store.loadAttachmentImage(id, signal),
    [id],
  );
  const { src, error } = useImageUrl(loadImage);

  return (
    <ImagePreview
      src={src}
      alt={alt}
      className="pending-group__image"
      loading={!src && !error}
      error={error}
    />
  );
}

export function PendingQueueGroups({
  ref,
  queue,
  pendingAction,
  onClear,
  onRecover,
  getText,
}: {
  ref?: Ref<HTMLElement>;
  queue: PendingQueues;
  pendingAction: "clear" | "recover" | null;
  onClear: () => Promise<boolean>;
  onRecover: () => Promise<boolean>;
  getText: (
    revision: number,
    itemId?: string,
    signal?: AbortSignal,
  ) => Promise<CopySource | null>;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (queue.totalCount === 0) setConfirmClear(false);
  }, [queue.totalCount]);

  const groups = [
    {
      key: "steering",
      label: "Steer",
      start: 0,
      items: queue.steering,
    },
    {
      key: "follow-up",
      label: "Queue",
      start: queue.steering.length,
      items: queue.followUp,
    },
  ].filter((group) => group.items.length > 0);
  const entries = [...queue.steering, ...queue.followUp];
  const busy = pendingAction !== null;

  async function returnToComposer() {
    const owner = store.getState();
    let focusChanged = false;
    const onFocus = () => {
      focusChanged = true;
    };
    document.addEventListener("focusin", onFocus);
    try {
      if (!(await onRecover())) return;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const current = store.getState();
      if (
        !focusChanged &&
        !hasActiveModal() &&
        current.sessionId === owner.sessionId &&
        current.transcriptViewId === owner.transcriptViewId &&
        current.transportGeneration === owner.transportGeneration &&
        !current.sessionSelectionPending
      )
        document
          .querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
          ?.focus();
    } finally {
      document.removeEventListener("focusin", onFocus);
    }
  }

  const omitted = queue.totalCount - entries.length;
  const singleMode = omitted === 0 && groups.length === 1;
  if (queue.totalCount === 0) return null;

  return (
    <section
      ref={ref}
      className="pending-groups"
      aria-label="Pending input"
      tabIndex={-1}
    >
      <div className="pending-groups__head">
        <div className="pending-groups__lead">
          <span className="pending-groups__title">
            {singleMode ? `Pending · ${groups[0]!.label}` : "Pending input"}
          </span>
          <span
            className="pending-groups__count"
            title={`${queue.totalCount} pending items`}
          >
            <span aria-hidden>{queue.totalCount}</span>
            <span className="visually-hidden">
              {queue.totalCount} pending items
            </span>
          </span>
        </div>
        <div className="pending-groups__actions">
          {queue.totalCount > 0 ? (
            <CopyAction
              key={queue.revision}
              getContent={copyLoader(
                (signal) => getText(queue.revision, undefined, signal),
                queue.totalImageCount === undefined
                  ? null
                  : { text: true, image: queue.totalImageCount > 0 },
              )}
              label="all pending input"
              className="pending-group__copy"
            />
          ) : null}
          <button
            type="button"
            className="icon-button pending-group__control"
            aria-label="Return all Pending input to composer"
            title="Return text and images to your draft. Pi keeps working."
            disabled={busy}
            onClick={() => void returnToComposer()}
          >
            {pendingAction === "recover" ? (
              <PiLoader size={13} aria-hidden />
            ) : (
              <CornerUpLeft size={13} aria-hidden />
            )}
          </button>
          {confirmClear ? (
            <span className="pending-groups__confirm">
              <span className="pending-groups__confirm-label">Clear all?</span>
              <button
                type="button"
                className="pending-groups__confirm-btn"
                disabled={busy}
                onClick={() =>
                  void onClear().then((cleared) => {
                    if (cleared) setConfirmClear(false);
                  })
                }
              >
                Clear all
              </button>
              <button
                type="button"
                className="pending-groups__confirm-cancel"
                aria-label="Cancel clearing Pending input"
                disabled={busy}
                onClick={() => setConfirmClear(false)}
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="icon-button pending-group__control pending-group__control--clear"
              aria-label="Clear all Pending input"
              title="Clear all Pending input"
              disabled={busy}
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 size={13} aria-hidden />
            </button>
          )}
        </div>
      </div>
      {omitted > 0 ? (
        <p className="pending-groups__omitted">
          {omitted} more pending {omitted === 1 ? "item" : "items"} not shown.
        </p>
      ) : null}
      {groups.map((group) => (
        <section
          key={group.key}
          className={`pending-group pending-group--${group.key}`}
          aria-label={`Pending ${group.label.toLowerCase()}`}
        >
          {!singleMode ? (
            <div className="pending-group__head">{group.label}</div>
          ) : null}
          <ol className="pending-group__list" start={group.start + 1}>
            {group.items.map((entry, index) => {
              const number = group.start + index + 1;
              const canCopy = entry.textLength > 0 || Boolean(entry.imageCount);
              return (
                <li key={entry.id} className="pending-group__item">
                  <span className="pending-group__number" aria-hidden>
                    {number}.
                  </span>
                  <div className="pending-group__content">
                    {entry.textPreview || !entry.imageCount ? (
                      <pre
                        className={
                          entry.textPreview ? undefined : "is-placeholder"
                        }
                      >
                        {entry.textPreview || "No text"}
                      </pre>
                    ) : null}
                    {entry.imageAttachmentIds?.length ? (
                      <ImageGallery>
                        <div
                          className="pending-group__images"
                          role="group"
                          aria-label={`${entry.imageAttachmentIds.length} ${entry.imageAttachmentIds.length === 1 ? "image" : "images"}`}
                        >
                          {entry.imageAttachmentIds.map((id, imageIndex) => (
                            <PendingImage
                              key={id}
                              id={id}
                              alt={`Pending ${group.label.toLowerCase()} item ${index + 1} image ${imageIndex + 1}`}
                            />
                          ))}
                        </div>
                      </ImageGallery>
                    ) : entry.imageCount ? (
                      <span className="pending-group__image-count">
                        <ImageIcon size={13} aria-hidden />
                        {entry.imageCount === 1
                          ? "Image"
                          : `${entry.imageCount} images`}
                      </span>
                    ) : null}
                  </div>
                  <div className="pending-group__item-actions">
                    {canCopy ? (
                      <CopyAction
                        key={queue.revision}
                        getContent={copyLoader(
                          (signal) => getText(queue.revision, entry.id, signal),
                          queue.totalImageCount === undefined
                            ? null
                            : {
                                text: entry.textLength > 0 || !entry.imageCount,
                                image: Boolean(entry.imageCount),
                              },
                        )}
                        label={`${group.label} item ${index + 1}`}
                        className="pending-group__copy"
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </section>
  );
}

export function ExtensionDisplaySurface({
  displays,
}: {
  displays: GenericExtensionDisplay[];
}) {
  if (displays.length === 0) return null;
  return (
    <section
      className="extension-surface"
      aria-label="Extension display content"
    >
      <div className="extension-surface__head">
        <Package size={14} aria-hidden /> Extension display
      </div>
      {displays.map((display) => (
        <details key={display.id} className="extension-surface__item">
          <summary>
            <code>{display.method}</code>
            <span>
              {display.source} · {display.label}
            </span>
          </summary>
          <pre className="card__mono">
            {JSON.stringify(display.payload, null, 2)}
          </pre>
        </details>
      ))}
    </section>
  );
}
