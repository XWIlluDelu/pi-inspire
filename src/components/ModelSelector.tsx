import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type ModelIdentity,
  type ModelOption,
  modelIdentityKey,
} from "../../shared/contracts";
import {
  type FloatingMenuConstraints,
  useFloatingMenuPlacement,
} from "../use-floating-menu";
import { useModalPortal } from "../use-modal-focus";
import { ModelList } from "./ModelList";

const EMPTY_IDENTITIES: readonly ModelIdentity[] = [];
const MODEL_MENU_CONSTRAINTS: FloatingMenuConstraints = {
  gap: 4,
  horizontalMargin: 16,
  verticalMargin: 8,
  maxWidth: 520,
  maxHeight: 440,
};
export function ModelSelector({
  value,
  models,
  recent,
  onChange,
  emptyLabel = "Model unavailable",
  disabled = false,
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
  onChange: (provider: string, id: string) => void | Promise<unknown>;
  emptyLabel?: string;
  disabled?: boolean;
  openRequest?: { id: number; query?: string };
  onOpenRequestHandled?: (id: number) => void;
  refreshModels?: () => Promise<string | undefined>;
  common?: readonly ModelIdentity[];
  onManageModels?: () => void;
  selectCurrent?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const handledOpenRequest = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState("");
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const resolveMenuTarget = useCallback(() => {
    const root = rootRef.current,
      trigger = triggerRef.current;
    if (!root || !trigger) return null;
    return {
      context: root,
      anchor: trigger.getBoundingClientRect(),
      observe: [trigger],
    };
  }, []);
  const placement = useFloatingMenuPlacement(
    open,
    resolveMenuTarget,
    MODEL_MENU_CONSTRAINTS,
  );
  useModalPortal(Boolean(open && placement), triggerRef, menuRef);
  const show = useCallback(
    (query = "") => {
      if (!models.length && !refreshModels && !onManageModels) return;
      setInitialQuery(query);
      setOpen(true);
    },
    [models.length, refreshModels, onManageModels],
  );
  useEffect(() => {
    if (!openRequest || handledOpenRequest.current === openRequest.id) return;
    handledOpenRequest.current = openRequest.id;
    if (!disabled) show(openRequest.query ?? "");
    onOpenRequestHandled?.(openRequest.id);
  }, [disabled, openRequest, onOpenRequestHandled, show]);
  useEffect(() => {
    const generation = ++refreshGeneration.current;
    if (!open || !refreshModels) return;
    setRefreshStatus("Refreshing models…");
    void refreshModels().then(
      (warning) => {
        if (refreshGeneration.current === generation)
          setRefreshStatus(warning ?? null);
      },
      () => {
        if (refreshGeneration.current === generation)
          setRefreshStatus("Could not refresh models");
      },
    );
    return () => {
      ++refreshGeneration.current;
    };
  }, [open, refreshModels]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | FocusEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      )
        setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("focusin", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("focusin", close);
    };
  }, [open]);
  const restoreTriggerFocus = () =>
    requestAnimationFrame(() =>
      triggerRef.current?.focus({ preventScroll: true }),
    );
  const pick = (model: ModelOption) => {
    setOpen(false);
    restoreTriggerFocus();
    if (
      selectCurrent ||
      !value ||
      modelIdentityKey(model) !== modelIdentityKey(value)
    ) {
      const trigger = triggerRef.current;
      const selection = onChange(model.provider, model.id);
      const settled = () =>
        requestAnimationFrame(() => {
          if (
            triggerRef.current === trigger &&
            document.activeElement === document.body
          )
            trigger?.focus({ preventScroll: true });
        });
      void selection?.then(settled, settled);
    }
  };
  const onMenuKey = (event: React.KeyboardEvent) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      restoreTriggerFocus();
    } else if (event.key === "Tab") {
      if (onManageModels && !event.shiftKey) return;
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    }
  };
  const display = value?.name ?? value?.id ?? emptyLabel;
  return (
    <div className="model-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="dropdown__trigger model-picker__trigger"
        aria-label="Model"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={
          disabled || (!models.length && !refreshModels && !onManageModels)
        }
        title={
          value?.reasoning === false
            ? `${display} — thinking is not supported`
            : `${display} — ${value?.provider ?? "no provider"}`
        }
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (open) onMenuKey(event);
          else if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            show();
          }
        }}
      >
        <span className="model-picker__trigger-copy">
          <span className="dropdown__value">{display}</span>
        </span>
        <ChevronDown size={11} aria-hidden />
      </button>
      {open && placement
        ? createPortal(
            <div
              ref={menuRef}
              className="model-picker__menu dropdown__menu"
              data-placement={placement.direction}
              style={{
                left: placement.left,
                top: placement.top,
                bottom: placement.bottom,
                width: placement.width,
                maxHeight: placement.maxHeight,
              }}
            >
              <ModelList
                key={openRequest?.id}
                models={models}
                value={value}
                recent={recent}
                common={common}
                initialQuery={initialQuery}
                status={refreshStatus}
                onSelect={pick}
                onKeyDown={onMenuKey}
                autoFocus
              />
              {onManageModels ? (
                <button
                  type="button"
                  className="model-picker__manage"
                  onClick={() => {
                    setOpen(false);
                    onManageModels();
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Escape" &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      setOpen(false);
                      restoreTriggerFocus();
                    }
                    if (event.key === "Tab" && !event.shiftKey) {
                      setOpen(false);
                      triggerRef.current?.focus({ preventScroll: true });
                    }
                  }}
                >
                  Manage models
                </button>
              ) : null}
            </div>,
            triggerRef.current?.closest(".overlay") ?? document.body,
          )
        : null}
    </div>
  );
}
