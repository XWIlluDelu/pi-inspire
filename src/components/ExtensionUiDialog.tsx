import { Puzzle } from "lucide-react";
import {
  memo,
  type Ref,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import type { ExtensionUiRequest } from "../../shared/contracts";
import { ExtensionDialogContent } from "./ExtensionDialogContent";
import { shallowEqual, store, useAppState } from "../store";
import { useModalFocus } from "../use-modal-focus";

type Respond = (payload: Record<string, unknown>) => void;

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

function DialogBody({
  request,
  responding,
  error,
  onRespond,
}: {
  request: ExtensionUiRequest;
  responding: boolean;
  error: string | null;
  onRespond: Respond;
}) {
  const [value, setValue] = useState(
    request.method === "editor" && "prefill" in request
      ? (request.prefill ?? "")
      : "",
  );
  return (
    <ExtensionDialogContent
      request={request}
      value={value}
      pending={responding}
      error={error}
      onValueChange={setValue}
      onRespond={onRespond}
      onCancel={() => onRespond({ id: request.id, cancelled: true })}
    />
  );
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
      requests: state.extensionUiRequests,
      respondingId: state.extensionUiRespondingId,
      runState: state.runState,
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
  const onRespond: Respond = (payload) => {
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
  const dialogRef = useModalFocus<HTMLDivElement>(
    Boolean(request),
    owner,
    request ? cancel : undefined,
  );
  if (!request) return null;
  return (
    <div className="overlay" role="presentation">
      <div
        ref={dialogRef}
        className="dialog extension-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={request.title || "Pi extension request"}
        aria-busy={responding}
        tabIndex={-1}
      >
        <div className="extension-dialog__identity">
          <Puzzle size={14} aria-hidden /> Extension request
        </div>
        {/* key remounts the form state per request */}
        <DialogBody
          key={`${request.sessionId}:${request.id}`}
          request={request}
          responding={responding}
          error={responseError?.owner === owner ? responseError.message : null}
          onRespond={onRespond}
        />
        {request.expiresAt !== undefined ? (
          <RequestTime
            key={`${request.sessionId}:${request.id}:${request.expiresAt}`}
            expiresAt={request.expiresAt}
          />
        ) : null}
      </div>
    </div>
  );
});
