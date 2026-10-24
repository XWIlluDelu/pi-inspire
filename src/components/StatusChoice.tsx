import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { StatusControlDeclaration } from "../../shared/tool-presentation-config";
import { controlState } from "../presentation-adapters";
import { store } from "../store";

export function StatusChoiceIndicator({
  control,
  status,
  draftValue,
}: {
  control: StatusControlDeclaration;
  status?: string;
  draftValue?: string | null;
}) {
  const snapshot = controlState(control, status);
  const option = control.options.find(
    (option) =>
      option.value ===
      (draftValue === undefined ? snapshot?.value : draftValue),
  );
  const mask = useId();
  if (!option?.indicator) return null;
  const inactive =
    snapshot?.active === false || snapshot?.supported?.[option.value] === false;
  const label =
    (option.title ?? option.label) +
    (draftValue !== undefined
      ? ", for the new session"
      : inactive
        ? ", inactive for this model"
        : "");
  const front = "M11.5 2.2 5 9.7h4l-.5 5.5L15 7.7h-4z";
  return (
    <span
      className="status-choice-indicator"
      role="img"
      data-inactive={inactive}
      aria-label={label}
      title={label}
    >
      <svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth={option.indicator === "bolt" ? 1.5 : 1.3}
        strokeLinejoin="round"
        aria-hidden
      >
        {option.indicator === "bolt" ? (
          <path d="M9.5 1.5 3 9h4l-.5 5.5L13 7H9z" />
        ) : (
          <>
            <defs>
              <mask
                id={mask}
                maskUnits="userSpaceOnUse"
                x="0"
                y="0"
                width="16"
                height="16"
              >
                <rect width="16" height="16" fill="white" stroke="none" />
                <path d={front} fill="black" stroke="black" strokeWidth="2.5" />
              </mask>
            </defs>
            <path
              mask={`url(#${mask})`}
              d="M7.5 .8 1 8.3h4l-.5 5.5L11 6.3H7z"
            />
            <path d={front} />
          </>
        )}
      </svg>
    </span>
  );
}

/** Data-only adapter choices use native range input and the ordinary Pi command path.
 * An RPC status confirms selection; neither command receipts nor drag previews do. */
export function StatusChoice({
  control,
  status,
  disabled,
  owner = null,
  generation = 0,
  draft,
}: {
  control: StatusControlDeclaration;
  status?: string;
  disabled: boolean;
  owner?: string | null;
  generation?: number;
  draft?: { value: string | null; onSelect: (value: string) => void };
}) {
  const snapshot = controlState(control, status);
  const range = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const [preview, setPreview] = useState<number | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState("");
  const requested = useRef<string | null>(null);
  const confirmedValue = useRef(snapshot?.value);
  confirmedValue.current = snapshot?.value;
  const value = draft ? draft.value : snapshot?.value;
  const confirmedIndex = control.options.findIndex(
    (option) => option.value === value,
  );
  const index = preview ?? Math.max(0, confirmedIndex);
  const selected = control.options[index]!;
  const unavailable = disabled || (!draft && !snapshot) || pending !== null;
  const owned = () =>
    alive.current &&
    Boolean(
      draft ||
        (store.getState().sessionId === owner &&
          store.getState().transportGeneration === generation),
    );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (snapshot?.value === requested.current) {
      setPending(null);
      setError("");
      requested.current = null;
    }
    setPreview(null);
  }, [snapshot?.value, draft?.value]);

  async function request(value: string, consent = false) {
    if (unavailable || !owned()) return;
    const option = control.options.find((item) => item.value === value);
    if (!option || value === (draft ? draft.value : snapshot?.value)) return;
    if (option.confirmation && !consent) {
      setConfirmation(value);
      return;
    }
    setConfirmation(null);
    setPreview(null);
    setError("");
    if (draft) {
      draft.onSelect(value);
      return;
    }
    requested.current = value;
    setPending(value);
    try {
      const receipt = await store.selectStatusControl(control, value, owner);
      if (owned()) setPending(null);
      if (owned() && !receipt && confirmedValue.current !== value) {
        setPending(null);
        setError("The change was not accepted.");
      }
    } catch (error) {
      if (owned() && confirmedValue.current !== value) {
        setPending(null);
        setError(
          error instanceof Error
            ? error.message
            : "Could not change selection.",
        );
      }
    }
  }
  const requestRef = useRef(request);
  requestRef.current = request;
  useLayoutEffect(() => {
    const element = range.current;
    const commit = () => {
      setPreview(null);
      void requestRef.current(control.options[Number(element?.value)]!.value);
    };
    element?.addEventListener("change", commit);
    return () => element?.removeEventListener("change", commit);
  }, [control]);
  const hint =
    error ||
    (draft
      ? value
        ? (selected.description ?? "")
        : "Pi default until selected."
      : !snapshot
        ? "Selection status is not available yet."
        : snapshot.supported?.[snapshot.value] === false
          ? "Requested; inactive for this model."
          : (selected.description ?? ""));
  const confirmOption = control.options.find(
    (option) => option.value === confirmation,
  );
  return (
    <section
      className="status-choice"
      aria-label={control.label}
      aria-busy={pending !== null}
      data-unknown={confirmedIndex < 0}
      data-pending={pending !== null}
      style={
        { "--choice-count": control.options.length } as React.CSSProperties
      }
    >
      <div className="status-choice__track">
        <div className="status-choice__line" aria-hidden />
        <div className="status-choice__dots" aria-hidden>
          {control.options.map((option, i) => (
            <span
              key={option.value}
              data-selected={confirmedIndex >= 0 && i === index}
              data-focus-target={i === index}
            />
          ))}
        </div>
        <input
          ref={range}
          type="range"
          min="0"
          max={control.options.length - 1}
          step="1"
          aria-label={control.label}
          aria-valuetext={
            confirmedIndex >= 0
              ? (selected.title ?? selected.label)
              : draft
                ? "Pi default"
                : "Unknown"
          }
          disabled={unavailable}
          value={index}
          onChange={() => {}}
          onInput={(event) => setPreview(Number(event.currentTarget.value))}
          onPointerCancel={() => setPreview(null)}
          onKeyDown={(event) => {
            if (draft && ["Home", "End", "Enter", " "].includes(event.key)) {
              event.preventDefault();
              const target =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? control.options.length - 1
                    : index;
              void request(control.options[target]!.value);
            }
          }}
        />
      </div>
      <div className="status-choice__labels" aria-hidden>
        {control.options.map((option, i) => (
          <span
            key={option.value}
            title={option.title ?? option.label}
            data-selected={confirmedIndex >= 0 && i === index}
            onClick={() => {
              range.current?.focus();
              void request(option.value);
            }}
          >
            {option.label}
          </span>
        ))}
      </div>
      {hint ? (
        <p className="status-choice__hint" role="status">
          {hint}
        </p>
      ) : null}
      {confirmOption ? (
        <div
          className="status-choice__confirmation"
          role="group"
          aria-label="Confirm selection"
        >
          <p>{confirmOption.confirmation}</p>
          <button
            type="button"
            onClick={() => void request(confirmOption.value, true)}
          >
            Enable {confirmOption.title ?? confirmOption.label}
          </button>
          <button type="button" onClick={() => setConfirmation(null)}>
            Cancel
          </button>
        </div>
      ) : null}
    </section>
  );
}
