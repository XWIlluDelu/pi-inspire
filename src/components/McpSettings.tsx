import {
  ArrowLeft,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
type Editor = { scope: McpConfigScope; entry: McpConfigEntry | null };
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
      transport: source.transportGeneration,
    }),
    shallowEqual,
  );
  return (
    <McpConfiguration
      key={JSON.stringify([owner, state.transport])}
      owner={owner}
      active={active}
    />
  );
}
function McpConfiguration({
  owner,
  active,
}: {
  owner: Owner;
  active: boolean;
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
          aria-label={editor.entry ? "Edit MCP server" : "Add MCP server"}
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
                {editor.entry ? `Edit ${editor.entry.name}` : "Add MCP server"}
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
            initialScope={editor.scope}
            snapshot={snapshot}
            busy={busy}
            error={error}
            onSave={submit}
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
        >
          <div className="models-settings mcp-config">
            <div className="models-subheading">
              <span className="models-status">Server configuration</span>
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
                  className="button button--quiet"
                  ref={addButton}
                  disabled={busy || !snapshot}
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    setError(null);
                    setEditor({ scope: "user", entry: null });
                  }}
                >
                  <Plus size={14} aria-hidden />
                  Add server
                </button>
              </div>
            </div>
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
                {owner.sessionId ? (
                  <button
                    type="button"
                    className="models-text-button"
                    onClick={() => setConfirmReload(!confirmReload)}
                  >
                    Reload selected session…
                  </button>
                ) : (
                  <p className="models-status">
                    New Pi workers read the saved configuration.
                  </p>
                )}
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
                    onClick={() => {
                      store.runPaletteNativeCommand("/reload");
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
                    <div className="models-declared-model" key={entry.name}>
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
                          {entry.enabled === false ? " · disabled in file" : ""}
                          {file.scope === "user" &&
                          snapshot.files
                            .find((item) => item.scope === "project")
                            ?.entries.some((item) => item.name === entry.name)
                            ? " · project override exists"
                            : ""}
                        </span>
                      </div>
                      <div className="models-actions">
                        <button
                          type="button"
                          className="models-icon-button"
                          aria-label={`Edit ${file.scope} server ${entry.name}`}
                          disabled={
                            busy || (!entry.transport && !entry.policyOnly)
                          }
                          onClick={(event) => {
                            opener.current = event.currentTarget;
                            setError(null);
                            setEditor({ scope: file.scope, entry });
                          }}
                        >
                          <Pencil size={14} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="models-icon-button"
                          aria-label={`Remove ${file.scope} server ${entry.name}`}
                          disabled={busy}
                          onClick={(event) => {
                            opener.current = event.currentTarget;
                            setError(null);
                            setRemoving({ scope: file.scope, entry });
                          }}
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </section>
            ))}
            {removing?.entry ? (
              <div
                className="models-confirm"
                role="group"
                aria-label="Remove MCP configuration"
              >
                <p>
                  Remove {removing.entry.name} from the {removing.scope} file?
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
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
