import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ToolLoadoutEntry,
  ToolLoadoutSnapshot,
} from "../../shared/contracts";
import { store, useAppState } from "../store";
import { EmptyState } from "./EmptyState";
import { DialogHeader, Modal } from "./Modal";
import { ToggleSwitch } from "./ToggleSwitch";

const exposureLabel = {
  direct: "Direct",
  "model-only": "Model only",
  codemode: "Codemode",
  deferred: "Deferred",
  hidden: "Hidden",
} satisfies Record<ToolLoadoutEntry["exposure"], string>;

type ToolChange = { workerId: string; name: string; active: boolean };

export function ToolLoadoutDialog({
  sessionId,
  viewId,
  transportGeneration,
  active,
  onClose,
}: {
  sessionId: string;
  viewId: string;
  transportGeneration: number;
  active: boolean;
  onClose: () => void;
}) {
  const ownsView = useAppState(
    (state) =>
      state.sessionId === sessionId &&
      state.view.viewId === viewId &&
      state.transportGeneration === transportGeneration &&
      !state.sessionSelectionPending,
  );
  const [snapshot, setSnapshot] = useState<ToolLoadoutSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: true } | null>(
    null,
  );
  const request = useRef<AbortController | null>(null);

  const observe = useCallback(
    async (change?: ToolChange) => {
      if (request.current) return;
      const controller = new AbortController();
      request.current = controller;
      setPending(change?.name ?? "");
      setNotice(null);
      try {
        const result = await store.toolLoadout(
          { sessionId, viewId, transportGeneration },
          controller.signal,
          change,
        );
        if (controller.signal.aborted) return;
        setSnapshot(result);
        if (change) {
          const tool = result.tools.find(({ name }) => name === change.name);
          if (tool && tool.active !== change.active)
            setNotice({
              text: `Pi kept ${change.name} ${tool.active ? "active" : "inactive"}.`,
            });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const detail =
          error instanceof Error ? error.message : "Could not read Pi's tools.";
        setNotice({
          error: true,
          text: change
            ? `${detail} Refresh to check Pi’s tool selection.`
            : detail,
        });
        setSnapshot(null);
      } finally {
        if (request.current === controller) {
          request.current = null;
          setPending(null);
        }
      }
    },
    [sessionId, viewId, transportGeneration],
  );

  useEffect(() => {
    if (!ownsView) {
      onClose();
      return;
    }
    void observe();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [observe, onClose, ownsView]);

  const filter = query.trim().toLowerCase();
  const visible = snapshot?.tools.filter((tool) =>
    [
      tool.name,
      tool.description,
      tool.source,
      exposureLabel[tool.exposure],
    ].some((text) => text.toLowerCase().includes(filter)),
  );
  return (
    <Modal
      aria-labelledby="tool-loadout-title"
      active={active && ownsView}
      onDismiss={onClose}
    >
      <section className="dialog tool-loadout">
        <DialogHeader
          title="Tool Loadout"
          id="tool-loadout-title"
          bar={false}
          closeLabel="Close Tool Loadout"
          onClose={onClose}
        />
        <p className="dialog__message">
          Choose the active tools for this Pi worker. Codemode and deferred
          tools may still be discovered when inactive.
        </p>
        <div className="tool-loadout__controls">
          <input
            type="search"
            className="text-field"
            aria-label="Filter tools"
            placeholder="Filter tools"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="button"
            onClick={() => void observe()}
            disabled={pending !== null}
          >
            Refresh
          </button>
        </div>
        {notice ? (
          <p
            className={notice.error ? "dialog__error" : "dialog__message"}
            role={notice.error ? "alert" : "status"}
          >
            {notice.text}
          </p>
        ) : null}
        {snapshot?.truncated ? (
          <p className="dialog__message">Pi returned a partial tool list.</p>
        ) : null}
        {snapshot && visible?.length ? (
          <ul className="tool-loadout__list" aria-label="Pi tools">
            {visible.map((tool) => (
              <li key={tool.name} className="tool-loadout__tool">
                <div>
                  <code>{tool.name}</code>
                  <small>
                    {exposureLabel[tool.exposure]}
                    {tool.source && ` · ${tool.source}`}
                  </small>
                </div>
                {tool.exposure !== "hidden" && (
                  <ToggleSwitch
                    label={tool.name}
                    checked={tool.active}
                    busy={pending === tool.name}
                    disabled={pending !== null && pending !== tool.name}
                    onChange={(active) =>
                      void observe({
                        workerId: snapshot.workerId,
                        name: tool.name,
                        active,
                      })
                    }
                  />
                )}
                {tool.description ? <p>{tool.description}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          !notice?.error && (
            <EmptyState
              role="status"
              title={
                snapshot
                  ? filter
                    ? "No matching tools"
                    : "Pi has no tools to show"
                  : "Loading Pi tools…"
              }
            />
          )
        )}
      </section>
    </Modal>
  );
}
