import { Puzzle } from "lucide-react";
import {
  memo,
  type Ref,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { selectedRunState } from "../app-state";
import { shallowEqual, store, useAppState } from "../store";
import {
  ExtensionDialogContent,
  type ExtensionDialogContentProps,
} from "./ExtensionDialogContent";
import { Modal } from "./Modal";
import {
  ActivityDetails,
  ActivityText,
} from "./transcript-activity-visibility";

function RequestTime({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  const time =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <p className="dialog__remaining">{time} remaining</p>;
}

export interface ExtensionUiDialogHandle {
  cancel(): void;
}

/** Web-native presentation of Pi extension_ui_request dialogs. */
export const ExtensionUiDialog = memo(function ExtensionUiDialog({
  ref,
}: {
  ref?: Ref<ExtensionUiDialogHandle>;
}) {
  const { requests, respondingId, runState } = useAppState(
    (state) => ({
      requests: state.live.extensionUiRequests,
      respondingId: state.live.extensionUiRespondingId,
      runState: selectedRunState(state),
    }),
    shallowEqual,
  );
  const request = requests[0] ?? null;
  const responding = Boolean(respondingId);
  const owner = request ? `${request.sessionId}:${request.id}` : null;
  const [responseError, setResponseError] = useState<{
    owner: string;
    message: string;
  } | null>(null);
  const onRespond = (payload: Record<string, unknown>) => {
    if (!owner) return;
    setResponseError(null);
    void store.respondExtensionUi(payload).then((message) => {
      if (message) setResponseError({ owner, message });
    });
  };
  const cancel = () => {
    // Conflict recovery is a host-owned Escape path and must remain available
    // even when this extension request is still visible.
    if (runState === "conflict") return false;
    if (request && !responding) onRespond({ id: request.id, cancelled: true });
  };
  useImperativeHandle(ref, () => ({ cancel }));
  if (!request) return null;
  const question: ExtensionDialogContentProps["question"] = request.unsupported
    ? {
        unsupported: true,
        title: request.title,
        details: (
          <ActivityDetails
            reader="extension-request"
            label="Request details"
            className="dialog__details"
          >
            {() => (
              <>
                <code>{request.method}</code>
                <ActivityText
                  label="Request payload"
                  text={JSON.stringify(request.payload, null, 2)}
                />
              </>
            )}
          </ActivityDetails>
        ),
      }
    : request;
  return (
    <Modal
      aria-label={request.title || "Pi extension request"}
      aria-busy={responding}
      owner={owner}
      onEscape={cancel}
    >
      <div className="dialog extension-dialog">
        <div className="extension-dialog__identity">
          <Puzzle size={14} aria-hidden /> Extension request
        </div>
        <ExtensionDialogContent
          key={owner}
          question={question}
          pending={responding}
          error={responseError?.owner === owner ? responseError.message : null}
          onAnswer={(answer) =>
            onRespond(
              typeof answer === "boolean"
                ? { id: request.id, confirmed: answer }
                : { id: request.id, value: answer },
            )
          }
          onCancel={() => onRespond({ id: request.id, cancelled: true })}
        />
        {request.expiresAt !== undefined ? (
          <RequestTime key={request.expiresAt} expiresAt={request.expiresAt} />
        ) : null}
      </div>
    </Modal>
  );
});
