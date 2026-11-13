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
import { selectedRunState } from "../app-state";
import { shallowEqual, store, useAppState } from "../store";
import { useConfigurationDocument } from "../use-configuration-document";
import { McpServerForm } from "./McpServerForm";
import { SettingsSection } from "./SettingsSection";

type Owner = { sessionId?: string; cwd?: string };
type Selection =
  | {
      kind: "edit";
      scope: McpConfigScope;
      entry: McpConfigEntry | null;
      policyName?: string;
    }
  | { kind: "remove"; scope: McpConfigScope; entry: McpConfigEntry };
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
      runState: selectedRunState(source),
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
  const { snapshot, error, setError, busy, readFailed, load, write } =
    useConfigurationDocument<McpConfigSnapshot>(
      JSON.stringify(owner),
      "MCP configuration is unavailable",
      true,
    );
  const [selection, setSelection] = useState<Selection | null>(null);
  const editor = selection?.kind === "edit" ? selection : null;
  const removing = selection?.kind === "remove" ? selection : null;
  const [saved, setSaved] = useState<string | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const readStarted = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const focusBack = useRef(false);
  const read = useCallback(
    () => load(() => store.readMcpConfig(owner)),
    [load, owner],
  );
  useLayoutEffect(
    () => () => {
      readStarted.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!active || readStarted.current) return;
    readStarted.current = true;
    void read();
  }, [active, read]);
  useLayoutEffect(() => {
    if (active && !selection && focusBack.current) {
      focusBack.current = false;
      (opener.current?.isConnected
        ? opener.current
        : addButton.current
      )?.focus();
    }
  }, [active, selection]);
  function closeEditor() {
    focusBack.current = true;
    setSelection(null);
    setError(null);
  }
  function open(trigger: HTMLElement, next: Selection) {
    opener.current = trigger;
    setSelection(next);
    setError(null);
    setConfirmReload(false);
  }
  async function save(edit: McpConfigEdit) {
    const result = await write(() => store.editMcpConfig(owner, edit));
    if (!result) return;
    setSaved(
      result.warning ??
        "Saved to file. Running sessions have not been reloaded.",
    );
    closeEditor();
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
            readFailed={readFailed}
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
          description="Saved MCP settings apply in new or reloaded sessions."
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
                disabled={busy || !snapshot || readFailed}
                onClick={(event) =>
                  open(event.currentTarget, {
                    kind: "edit",
                    scope: "user",
                    entry: null,
                  })
                }
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
                Loading servers…
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
                      ? "Run /reload in the original Pi terminal."
                      : "New sessions use the saved configuration."}
                  </p>
                )}
                {canReload && reloadBlocked ? (
                  <p className="models-status">
                    Wait for Pi to finish before reloading.
                  </p>
                ) : null}
              </div>
            ) : null}
            {confirmReload ? (
              <div className="models-confirm">
                <p>
                  Reload Pi in the selected session. Unsaved extension state may
                  be lost.
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
                        isBusyRunState(selectedRunState(current))
                      ) {
                        setError("Reload requires an available, idle session.");
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
                Select a project to edit its MCP settings.
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
                            projectFile?.entries.some(
                              (item) => item.name === entry.name,
                            )
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
                              disabled={busy || readFailed}
                              onClick={(event) =>
                                open(event.currentTarget, {
                                  kind: "edit",
                                  scope: "project",
                                  entry: null,
                                  policyName: entry.name,
                                })
                              }
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
                              busy ||
                              readFailed ||
                              (!entry.transport && !entry.policyOnly)
                            }
                            onClick={(event) =>
                              open(event.currentTarget, {
                                kind: "edit",
                                scope: file.scope,
                                entry,
                              })
                            }
                          >
                            <Pencil size={14} aria-hidden />
                          </button>
                          <button
                            type="button"
                            className="models-icon-button"
                            title="Remove server"
                            aria-label={`Remove ${file.scope} server ${entry.name}`}
                            disabled={busy || readFailed}
                            onClick={(event) =>
                              open(event.currentTarget, {
                                kind: "remove",
                                scope: file.scope,
                                entry,
                              })
                            }
                          >
                            <Trash2 size={14} aria-hidden />
                          </button>
                        </div>
                      </div>
                      {removing?.scope === file.scope &&
                      removing.entry.name === entry.name ? (
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
                              disabled={busy || readFailed}
                              onClick={() =>
                                void save({
                                  scope: file.scope,
                                  name: entry.name,
                                  operation: "remove",
                                  revision: file.revision,
                                })
                              }
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
