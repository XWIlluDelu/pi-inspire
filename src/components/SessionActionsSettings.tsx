import { ArrowDown, ArrowUp, ListOrdered } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { SessionActionId } from "../../shared/contracts";
import { moveSessionAction, SESSION_ACTION_LABELS } from "../session-actions";
import { SettingsSection } from "./SettingsSection";

export function SessionActionsSettings({
  order,
  onChange,
}: {
  order: readonly SessionActionId[];
  onChange: (order: SessionActionId[]) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const pendingFocus = useRef<{
    id: SessionActionId;
    direction: string;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    const row = list.current?.querySelector(`[data-action="${pending.id}"]`);
    const same = row?.querySelector<HTMLButtonElement>(
      `[data-direction="${pending.direction}"]:not(:disabled)`,
    );
    (
      same ?? row?.querySelector<HTMLButtonElement>("button:not(:disabled)")
    )?.focus({
      preventScroll: true,
    });
  }, [order]);

  return (
    <SettingsSection
      id="session-actions"
      icon={<ListOrdered size={14} />}
      title="Session actions"
      description="Reorder the session title menu."
    >
      <ol
        ref={list}
        className="session-action-order"
        aria-label="Session action order"
      >
        {order.map((id, index) => {
          const label = SESSION_ACTION_LABELS[id];
          return (
            <li className="session-action-order__row" key={id} data-action={id}>
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
                    data-direction={direction}
                    disabled={destination < 0 || destination >= order.length}
                    onClick={() => {
                      pendingFocus.current = { id, direction };
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
