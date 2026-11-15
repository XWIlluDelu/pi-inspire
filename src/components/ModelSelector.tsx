import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ModelIdentity,
  type ModelOption,
  modelIdentityKey,
} from "../../shared/contracts";
import { isComposingKeyboardEvent } from "../keyboard-input";
import type { FloatingMenuConstraints } from "../use-floating-menu";
import { AnchoredPanel } from "./ChoicePanel";
import { ModelList } from "./ModelList";
import { PiLoader } from "./PiLoader";

const EMPTY_IDENTITIES: readonly ModelIdentity[] = [];
const MODEL_MENU_CONSTRAINTS: FloatingMenuConstraints = {
  gap: 4,
  horizontalMargin: 16,
  verticalMargin: 8,
  maxWidth: 384,
  maxHeight: 456,
};
export function ModelSelector({
  value,
  models,
  recent,
  onChange,
  emptyLabel = "Model unavailable",
  disabled = false,
  loading = false,
  title,
  openRequest,
  onOpenRequestHandled,
  refreshModels,
  common = EMPTY_IDENTITIES,
  onManageModels,
  selectCurrent = false,
}: {
  value: ModelOption | null;
  models: ModelOption[];
  recent: ModelIdentity[];
  onChange: (provider: string, id: string) => void;
  emptyLabel?: string;
  disabled?: boolean;
  loading?: boolean;
  title?: string;
  openRequest?: { id: number; query?: string };
  onOpenRequestHandled?: (id: number) => void;
  refreshModels?: () => Promise<string | undefined>;
  common?: readonly ModelIdentity[];
  onManageModels?: () => void;
  selectCurrent?: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const handledOpenRequest = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState("");
  const [refreshStatus, setRefreshStatus] = useState<string | null>();
  const refreshing = refreshStatus === undefined && Boolean(refreshModels);
  const isDisabled =
    disabled || (!models.length && !refreshModels && !onManageModels);
  const show = useCallback(
    (query = "") => {
      if (isDisabled) return;
      setInitialQuery(query);
      setOpen(true);
    },
    [isDisabled],
  );
  useEffect(() => {
    if (isDisabled) setOpen(false);
  }, [isDisabled]);
  useEffect(() => {
    if (!openRequest || handledOpenRequest.current === openRequest.id) return;
    handledOpenRequest.current = openRequest.id;
    if (!disabled) show(openRequest.query ?? "");
    onOpenRequestHandled?.(openRequest.id);
  }, [disabled, openRequest, onOpenRequestHandled, show]);
  useEffect(() => {
    if (!open || isDisabled || !refreshModels) return;
    let current = true;
    setRefreshStatus(undefined);
    void refreshModels().then(
      (warning) => {
        if (current) setRefreshStatus(warning ?? null);
      },
      () => {
        if (current) setRefreshStatus("Could not refresh models");
      },
    );
    return () => {
      current = false;
    };
  }, [open, isDisabled, refreshModels]);
  const close = () => setOpen(false);
  const pick = (model: ModelOption) => {
    if (isDisabled) return;
    close();
    requestAnimationFrame(() =>
      triggerRef.current?.focus({ preventScroll: true }),
    );
    if (
      selectCurrent ||
      !value ||
      modelIdentityKey(model) !== modelIdentityKey(value)
    )
      onChange(model.provider, model.id);
  };
  const display = value?.name ?? value?.id ?? emptyLabel;
  return (
    <div className="model-picker">
      <button
        ref={triggerRef}
        type="button"
        className="model-picker__trigger"
        aria-label="Model"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={isDisabled}
        aria-busy={loading}
        title={
          title ??
          (value?.reasoning === false
            ? `${display} — thinking is not supported`
            : `${display} — ${value?.provider ?? "no provider"}`)
        }
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (isComposingKeyboardEvent(event.nativeEvent)) return;
          if (open) {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (
              event.key === "Tab" &&
              (!onManageModels || event.shiftKey)
            ) {
              close();
            }
          } else if (
            ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)
          ) {
            event.preventDefault();
            show();
          }
        }}
      >
        <span className="model-picker__trigger-copy">
          <span className="model-picker__value">{display}</span>
        </span>
        {loading ? (
          <PiLoader size={11} aria-hidden />
        ) : (
          <ChevronDown size={11} aria-hidden />
        )}
      </button>
      <AnchoredPanel
        open={open}
        anchorRef={triggerRef}
        onClose={close}
        constraints={MODEL_MENU_CONSTRAINTS}
        modelPicker={{ busy: refreshing && !models.length }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const onManage =
            event.target instanceof Element &&
            Boolean(event.target.closest(".model-picker__manage"));
          if (onManageModels && onManage === event.shiftKey) return;
          close();
          triggerRef.current?.focus({ preventScroll: true });
        }}
      >
        <ModelList
          key={openRequest?.id}
          models={models}
          value={value}
          recent={recent}
          common={common}
          initialQuery={initialQuery}
          status={
            refreshStatus ??
            (refreshing && !models.length ? "Loading models…" : null)
          }
          onSelect={pick}
          autoFocus
        />
        {onManageModels ? (
          <button
            type="button"
            className="model-picker__manage"
            onClick={() => {
              if (isDisabled) return;
              setOpen(false);
              onManageModels();
            }}
          >
            Manage models
          </button>
        ) : null}
      </AnchoredPanel>
    </div>
  );
}
