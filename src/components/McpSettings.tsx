import {
  ArrowLeft,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { isBusyRunState } from "../../shared/contracts";
import type {
  McpConfigEdit,
  McpConfigEntry,
  McpConfigScope,
  McpConfigSnapshot,
  McpConfigValues,
} from "../../shared/mcp";
import { shallowEqual, store, useAppState } from "../store";
import { McpServerForm } from "./McpServerForm";
import { SettingsSection } from "./SettingsSection";

type Owner = { sessionId?: string; cwd?: string };
type Editor = {
  scope: McpConfigScope;
  entry: McpConfigEntry | null;
  policyName?: string;
};
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "MCP configuration is unavailable";
export function McpSettings({
  active,
  owner,
}: {
  active: boolean;
  owner: Owner;
}) {
  const state = useAppState(
    (source) => ({
      readOnlyReason: source.readOnlyReason,
      sessionId: source.sessionId,
      runState: source.runState,
      external: Boolean(
        source.sessionId && source.sessionStatuses[source.sessionId]?.external,
      ),
      transport: source.transportGeneration,
    }),
    shallowEqual,
  );
  return (
    <McpConfiguration
      key={JSON.stringify([owner, state.transport])}
      owner={owner}
      active={active}
      canReload={Boolean(
        owner.sessionId &&
          owner.sessionId === state.sessionId &&
          !state.readOnlyReason &&
          !state.external,
      )}
      nativeReload={owner.sessionId === state.sessionId && state.external}
      reloadBlocked={isBusyRunState(state.runState)}
    />
  );
}
function McpConfiguration({
  owner,
  active,
  canReload,
  nativeReload,
  reloadBlocked,
}: {
  owner: Owner;
  active: boolean;
  canReload: boolean;
  nativeReload: boolean;
  reloadBlocked: boolean;
}) {
  const [snapshot, setSnapshot] = useState<McpConfigSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [removing, setRemoving] = useState<Editor | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const alive = useRef(false);
  const attempted = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const focusBack = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const read = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const value = await store.readMcpConfig(owner);
      if (alive.current) setSnapshot(value);
    } catch (error) {
      if (alive.current) setError(messageOf(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [owner]);
  useEffect(() => {
    if (!active || attempted.current) return;
    attempted.current = true;
    void read();
  }, [active, read]);
  useLayoutEffect(() => {
    if (active && !editor && !removing && focusBack.current) {
      focusBack.current = false;
      (opener.current?.isConnected
        ? opener.current
        : addButton.current
      )?.focus();
    }
  }, [active, editor, removing]);
  function closeEditor() {
    focusBack.current = true;
    setEditor(null);
    setRemoving(null);
    setError(null);
  }
  async function save(edit: McpConfigEdit) {
    setBusy(true);
    setError(null);
    try {
      const result = await store.editMcpConfig(owner, edit);
      if (!alive.current) return;
      setSnapshot(result.snapshot ?? null);
      setSaved(
        result.warning ??
          "Saved to file. Running sessions have not been reloaded.",
      );
      closeEditor();
    } catch (error) {
      if (alive.current) setError(messageOf(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const projectFile = snapshot?.files.find((file) => file.scope === "project");
  function submit(
    scope: McpConfigScope,
    name: string,
    values: McpConfigValues,
  ) {
    const file = snapshot?.files.find((file) => file.scope === scope);
    if (file)
      void save({
        scope,
        name,
        values,
        revision: file.revision,
        operation: editor?.entry ? "update" : "add",
      });
  }
  return (
    <div className="models-settings-layout mcp-settings">
      {editor && snapshot ? (
        <section
          className="models-editor models-settings"
          aria-label={
            editor.policyName
              ? "Customize MCP server for project"
              : editor.entry
                ? "Edit MCP server"
                : "Add MCP server"
          }
        >
          <header className="models-editor__header">
            <button
              type="button"
              className="button button--quiet"
              onClick={closeEditor}
              disabled={busy}
            >
              <ArrowLeft size={14} aria-hidden />
              Back to MCP
            </button>
            <div className="models-subheading">
              <h3>
                {editor.policyName
                  ? `Customize ${editor.policyName}`
                  : editor.entry
                    ? `Edit ${editor.entry.name}`
                    : "Add MCP server"}
              </h3>
              <button
                type="button"
                className="models-icon-button"
                aria-label="Refresh MCP files"
                title="Refresh files; keep this draft"
                disabled={busy}
                onClick={() => void read()}
              >
                <RefreshCw size={14} aria-hidden />
              </button>
            </div>
          </header>
          <McpServerForm
            entry={editor.entry}
            policyName={editor.policyName}
            initialScope={editor.scope}
            snapshot={snapshot}
            busy={busy}
            error={error}
            onSave={submit}
            onReadConnection={(input) => store.readMcpConnection(owner, input)}
            onCancel={closeEditor}
          />
        </section>
      ) : null}
      <div className="models-browse" hidden={Boolean(editor)}>
        <SettingsSection
          id="mcp"
          icon={<Server size={14} />}
          title="MCP"
          description="Edit Pi's saved MCP configuration. Changes take effect in new or reloaded sessions."
          headerAction={
            <div className="models-actions">
              <button
                type="button"
                className="models-icon-button"
                aria-label="Refresh MCP files"
                disabled={busy}
                onClick={() => void read()}
              >
                <RefreshCw size={14} aria-hidden />
              </button>
              <button
                type="button"
                className="button"
                ref={addButton}
                disabled={busy || !snapshot}
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  setError(null);
                  setConfirmReload(false);
                  setEditor({ scope: "user", entry: null });
                }}
              >
                <Plus size={14} aria-hidden />
                Add server
              </button>
            </div>
          }
        >
          <div className="models-settings mcp-config">
            {error ? (
              <p className="settings__error" role="alert">
                {error}
              </p>
            ) : null}
            {busy && !snapshot ? (
              <p className="models-status" role="status">
                Reading MCP files…
              </p>
            ) : null}
            {saved ? (
              <div className="mcp-save-result" role="status">
                <p className="models-status">{saved}</p>
                {canReload ? (
                  <button
                    type="button"
                    className="models-text-button"
                    disabled={reloadBlocked || busy}
                    onClick={() => setConfirmReload(!confirmReload)}
                  >
                    Reload selected session…
                  </button>
                ) : (
                  <p className="models-status">
                    {nativeReload
                      ? "Run /reload in the original Pi terminal to apply the saved configuration."
                      : "New Pi workers read the saved configuration."}
                  </p>
                )}
                {canReload && reloadBlocked ? (
                  <p className="models-status">
                    Wait for the current Pi operation to finish before
                    reloading.
                  </p>
                ) : null}
              </div>
            ) : null}
            {confirmReload ? (
              <div className="models-confirm">
                <p>
                  Reload restarts only the selected idle Pi worker. Other
                  running sessions are unchanged. Unsaved extension state may be
                  lost.
                </p>
                <div className="models-actions">
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={!canReload || reloadBlocked || busy}
                    onClick={() => {
                      setError(null);
                      const current = store.getState();
                      if (
                        current.sessionId !== owner.sessionId ||
                        current.readOnlyReason ||
                        isBusyRunState(current.runState)
                      ) {
                        setError(
                          "The selected session must be available and idle before reloading.",
                        );
                        return;
                      }
                      if (!store.runPaletteNativeCommand("/reload")) {
                        setError(
                          "Reload could not be started. Check the selected session and try again.",
                        );
                        return;
                      }
                      setConfirmReload(false);
                      setSaved(
                        "Reload requested. Check its result in the conversation.",
                      );
                    }}
                  >
                    Reload Pi resources
                  </button>
                  <button
                    type="button"
                    className="button button--quiet"
                    onClick={() => setConfirmReload(false)}
                  >
                    Cancel reload
                  </button>
                </div>
              </div>
            ) : null}
            {snapshot && snapshot.cwd === null ? (
              <p className="models-status">
                Select a project to edit project configuration.
              </p>
            ) : null}
            {snapshot?.files.map((file) => (
              <section
                className="mcp-file"
                key={file.scope}
                aria-label={
                  file.scope === "user"
                    ? "User MCP configuration"
                    : "Project MCP configuration"
                }
              >
                <div className="mcp-file__header">
                  <div className="mcp-file__scope">
                    <h4>
                      {file.scope === "user"
                        ? "User configuration"
                        : "Project configuration"}
                    </h4>
                    <span className="mcp-file__hint">
                      {file.scope === "user"
                        ? "Available to all projects"
                        : "Scoped to this project"}
                    </span>
                  </div>
                  <span className="mcp-path">{file.path}</span>
                </div>
                {file.error ? (
                  <p className="settings__error" role="alert">
                    {file.error}
                  </p>
                ) : !file.entries.length ? (
                  <p className="models-status">No servers in this file.</p>
                ) : (
                  file.entries.map((entry) => (
                    <Fragment key={entry.name}>
                      <div className="models-declared-model">
                        <div className="models-declared-model__copy">
                          <span>{entry.name}</span>
                          <span className="models-status">
                            {entry.policyOnly
                              ? "Policy override"
                              : entry.transport === "http"
                                ? "HTTP"
                                : entry.transport === "stdio"
                                  ? "Stdio"
                                  : "Unsupported entry"}
                            {entry.enabled === false
                              ? " · disabled in file"
                              : ""}
                            {file.scope === "user" &&
                            snapshot.files
                              .find((item) => item.scope === "project")
                              ?.entries.some((item) => item.name === entry.name)
                              ? " · project override exists"
                              : ""}
                          </span>
                          {file.scope === "user" &&
                          entry.transport &&
                          projectFile &&
                          !projectFile.error &&
                          !projectFile.entries.some(
                            (project) => project.name === entry.name,
                          ) ? (
                            <button
                              type="button"
                              className="models-text-button"
                              aria-label={`Customize for this project: ${entry.name}`}
                              disabled={busy}
                              onClick={(event) => {
                                opener.current = event.currentTarget;
                                setError(null);
                                setConfirmReload(false);
                                setEditor({
                                  scope: "project",
                                  entry: null,
                                  policyName: entry.name,
                                });
                              }}
                            >
                              Customize for this project
                            </button>
                          ) : null}
                        </div>
                        <div className="models-actions">
                          <button
                            type="button"
                            className="models-icon-button"
                            title="Edit server"
                            aria-label={`Edit ${file.scope} server ${entry.name}`}
                            disabled={
                              busy || (!entry.transport && !entry.policyOnly)
                            }
                            onClick={(event) => {
                              opener.current = event.currentTarget;
                              setError(null);
                              setConfirmReload(false);
                              setEditor({ scope: file.scope, entry });
                            }}
                          >
                            <Pencil size={14} aria-hidden />
                          </button>
                          <button
                            type="button"
                            className="models-icon-button"
                            title="Remove server"
                            aria-label={`Remove ${file.scope} server ${entry.name}`}
                            disabled={busy}
                            onClick={(event) => {
                              opener.current = event.currentTarget;
                              setError(null);
                              setConfirmReload(false);
                              setRemoving({ scope: file.scope, entry });
                            }}
                          >
                            <Trash2 size={14} aria-hidden />
                          </button>
                        </div>
                      </div>
                      {removing?.scope === file.scope &&
                      removing.entry?.name === entry.name ? (
                        <div
                          className="models-confirm"
                          role="group"
                          aria-label="Remove MCP configuration"
                        >
                          <p>
                            Remove {removing.entry.name} from the{" "}
                            {removing.scope} file?{" "}
                            {removing.entry.policyOnly
                              ? "This project will inherit the user configuration again. "
                              : ""}
                            Stored OAuth credentials and running connections are
                            unchanged.
                          </p>
                          <div className="models-actions">
                            <button
                              type="button"
                              className="button button--danger"
                              disabled={busy}
                              onClick={() => {
                                const file = snapshot?.files.find(
                                  (file) => file.scope === removing.scope,
                                );
                                if (file)
                                  void save({
                                    scope: file.scope,
                                    name: removing.entry!.name,
                                    operation: "remove",
                                    revision: file.revision,
                                  });
                              }}
                            >
                              Remove configuration
                            </button>
                            <button
                              type="button"
                              className="button button--quiet"
                              disabled={busy}
                              onClick={closeEditor}
                            >
                              Keep server
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </Fragment>
                  ))
                )}
              </section>
            ))}
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
