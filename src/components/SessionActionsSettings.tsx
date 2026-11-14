import { ArrowDown, ArrowUp, ListOrdered } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { SessionActionId } from "../../shared/contracts";
import { moveSessionAction, sessionActions } from "../session-actions";
import { SettingsSection } from "./SettingsSection";

export function SessionActionsSettings({
  order,
  onChange,
}: {
  order: readonly SessionActionId[];
  onChange: (order: SessionActionId[]) => void;
}) {
  const pendingFocus = useRef<HTMLButtonElement | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useLayoutEffect(() => {
    const button = pendingFocus.current;
    pendingFocus.current = null;
    const target = button?.disabled
      ? button.parentElement?.querySelector<HTMLButtonElement>("button:enabled")
      : button;
    target?.focus({ preventScroll: true });
  }, [order]);

  return (
    <SettingsSection
      id="session-actions"
      icon={<ListOrdered size={14} />}
      title="Session actions"
      description="Reorder the session title menu."
    >
      <ol className="session-action-order" aria-label="Session action order">
        {order.map((id, index) => {
          const label = sessionActions[id].title;
          return (
            <li className="session-action-order__row" key={id}>
              <span className="session-action-order__label">{label}</span>
              {(["up", "down"] as const).map((direction) => {
                const destination = index + (direction === "up" ? -1 : 1);
                const Icon = direction === "up" ? ArrowUp : ArrowDown;
                return (
                  <button
                    key={direction}
                    className="icon-button"
                    type="button"
                    aria-label={`Move ${label} ${direction}`}
                    title={`Move ${direction}`}
                    disabled={destination < 0 || destination >= order.length}
                    onClick={(event) => {
                      pendingFocus.current = event.currentTarget;
                      onChange(moveSessionAction(order, id, destination));
                      setAnnouncement(
                        `${label} moved to position ${destination + 1} of ${order.length}.`,
                      );
                    }}
                  >
                    <Icon size={16} aria-hidden />
                  </button>
                );
              })}
            </li>
          );
        })}
      </ol>
      <span className="sr-only" role="status">
        {announcement}
      </span>
    </SettingsSection>
  );
}
