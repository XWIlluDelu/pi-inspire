import { Plus, RefreshCw, Server } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { isBusyRunState } from "../../shared/contracts";
import type {
  McpConfigEdit,
  McpConfigEntry,
  McpConfigScope,
  McpConfigSnapshot,
  McpConfigValues,
} from "../../shared/mcp";
import type { ModelSettingsOwner } from "../../shared/model-settings";
import { selectedRunState } from "../app-state";
import { shallowEqual, store, useAppState } from "../store";
import { useConfigurationDocument } from "../use-configuration-document";
import {
  ConfigurationAction,
  ConfigurationConfirmation,
  ConfigurationDetail,
  ConfigurationEditor,
} from "./ConfigurationForm";
import { McpServerForm } from "./McpServerForm";
import { SettingsCardMessage, SettingsSection } from "./SettingsSection";

const transportLabel = (entry: McpConfigEntry) =>
  entry.policyOnly
    ? "Policy override"
    : entry.transport === "http"
      ? "HTTP"
      : entry.transport === "stdio"
        ? "Stdio"
        : "Unsupported entry";
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
  owner: ModelSettingsOwner;
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
      key={JSON.stringify([owner.sessionId, owner.cwd, state.transport])}
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
  owner: ModelSettingsOwner;
  active: boolean;
  canReload: boolean;
  nativeReload: boolean;
  reloadBlocked: boolean;
}) {
  const configuration = useConfigurationDocument<McpConfigSnapshot, Selection>({
    owner: JSON.stringify([owner.sessionId, owner.cwd]),
    active,
    unavailable: "MCP configuration is unavailable",
    blockDuringRead: true,
    fallbackFocus: "[data-config-add]",
  });
  const {
    snapshot,
    error,
    setError,
    busy,
    readFailed,
    load,
    write,
    edit: selection,
  } = configuration;
  const editor = selection?.kind === "edit" ? selection : null;
  const removing = selection?.kind === "remove" ? selection : null;
  const [saved, setSaved] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [reloading, setReloading] = useState(false);
  const { cwd, sessionId } = owner;
  const readConfig = useCallback(
    () => store.readMcpConfig(sessionId ? { sessionId } : { cwd }),
    [sessionId, cwd],
  );
  const read = useCallback(() => load(readConfig), [load, readConfig]);
  useEffect(() => {
    if (active && !snapshot && !readFailed) void read();
  }, [active, read, readFailed, snapshot]);
  useEffect(() => {
    if (!active || !configuration.browsing || !snapshot) return;
    const onVisibility = () => {
      if (document.visibilityState === "visible" && !busy && !reloading)
        void read();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [active, busy, configuration.browsing, read, reloading, snapshot]);
  const open = (next: Selection, opener: HTMLElement) => {
    configuration.open(next, opener, next.kind === "edit");
  };
  const projectFile = snapshot?.files.find((file) => file.scope === "project");
  function reload(successMessage = "Pi reloaded.") {
    if (!sessionId || store.getState().sessionId !== sessionId) return;
    setError(null);
    if (
      !store.reloadSessionResources(sessionId, (status, message) => {
        setReloading(false);
        if (status === "success") {
          setNeedsReload(false);
          setSaved(successMessage);
        } else if (status === "cancelled") {
          setNeedsReload(true);
          setSaved(message);
        } else {
          setNeedsReload(true);
          setError(message);
        }
      })
    ) {
      setNeedsReload(true);
      setError("Pi reload couldn’t start.");
      return;
    }
    setNeedsReload(false);
    setSaved("MCP settings saved.");
    setReloading(true);
  }
  function save(edit: McpConfigEdit) {
    void write(() => store.editMcpConfig(owner, edit), {
      close: true,
      readBack: readConfig,
      onSaved: () => {
        if (
          canReload &&
          !reloadBlocked &&
          sessionId &&
          store.getState().sessionId === sessionId
        ) {
          reload("MCP settings saved and Pi reloaded.");
          return;
        }
        setSaved("MCP settings saved.");
        setNeedsReload(canReload);
      },
      onError: () =>
        configuration.root.current?.querySelector<HTMLElement>(
          '.models-form [role="alert"], .mcp-config > [role="alert"]',
        ) ?? null,
    });
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
    <div
      className="models-settings-layout mcp-settings"
      ref={configuration.root}
    >
      {editor && snapshot && (
        <ConfigurationEditor
          title={
            editor.policyName
              ? `Customize ${editor.policyName}`
              : editor.entry
                ? `Edit ${editor.entry.name}`
                : "Add MCP server"
          }
          backLabel="Back to MCP"
          busy={busy}
          onClose={configuration.dismiss}
          refresh={{ label: "Refresh MCP files", run: () => void read() }}
        >
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
            onCancel={configuration.dismiss}
          />
        </ConfigurationEditor>
      )}
      <div className="models-browse" hidden={!configuration.browsing}>
        <SettingsSection
          id="mcp"
          icon={<Server size={14} />}
          title="MCP"
          description="Saved MCP settings reload idle sessions automatically."
          headerAction={
            <div className="models-actions">
              <ConfigurationAction
                label="Refresh MCP files"
                icon={RefreshCw}
                disabled={busy}
                onClick={() => void read()}
              />
              <button
                type="button"
                className="button"
                data-config-add
                disabled={busy || !snapshot || readFailed}
                onClick={(event) =>
                  open(
                    { kind: "edit", scope: "user", entry: null },
                    event.currentTarget,
                  )
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
              <SettingsCardMessage error>{error}</SettingsCardMessage>
            ) : null}
            {busy && !snapshot ? (
              <SettingsCardMessage loading>
                Loading servers…
              </SettingsCardMessage>
            ) : null}
            {saved ? (
              <div className="mcp-save-result" role="status">
                <p className="models-status">
                  {reloading ? "Reloading Pi…" : saved}
                </p>
                {canReload && needsReload ? (
                  <button
                    type="button"
                    className="models-text-button"
                    disabled={reloadBlocked || reloading || busy}
                    onClick={() => reload()}
                  >
                    Reload selected session
                  </button>
                ) : nativeReload ? (
                  <p className="models-status">
                    Run /reload in the original Pi terminal.
                  </p>
                ) : null}
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
                aria-label={`${file.scope === "user" ? "User" : "Project"} MCP configuration`}
              >
                <div className="mcp-file__header">
                  <div className="mcp-file__scope">
                    <h4>
                      {file.scope === "user" ? "User" : "Project"} configuration
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
                ) : file.entries.length === 0 ? (
                  <p className="models-status">No servers in this file.</p>
                ) : (
                  file.entries.map((entry) => {
                    const scope = file.scope;
                    const hasOverride = projectFile?.entries.some(
                      ({ name }) => name === entry.name,
                    );
                    const customize =
                      scope === "user" &&
                      entry.transport &&
                      projectFile &&
                      !projectFile.error &&
                      !hasOverride;
                    return (
                      <Fragment key={entry.name}>
                        <ConfigurationDetail
                          label={`${scope} server ${entry.name}`}
                          name={entry.name}
                          description={
                            <p className="models-status">
                              {transportLabel(entry)}
                              {entry.enabled === false && " · disabled in file"}
                              {scope === "user" &&
                                hasOverride &&
                                " · project override exists"}
                            </p>
                          }
                          disabled={busy || readFailed}
                          edit={
                            entry.transport || entry.policyOnly
                              ? (event) =>
                                  open(
                                    { kind: "edit", scope, entry },
                                    event.currentTarget,
                                  )
                              : undefined
                          }
                          remove={(event) =>
                            open(
                              { kind: "remove", scope, entry },
                              event.currentTarget,
                            )
                          }
                        >
                          {customize && (
                            <button
                              type="button"
                              className="models-text-button"
                              aria-label={`Customize for this project: ${entry.name}`}
                              disabled={busy || readFailed}
                              onClick={(event) =>
                                open(
                                  {
                                    kind: "edit",
                                    scope: "project",
                                    entry: null,
                                    policyName: entry.name,
                                  },
                                  event.currentTarget,
                                )
                              }
                            >
                              Customize for this project
                            </button>
                          )}
                        </ConfigurationDetail>
                        {removing &&
                          scope === removing.scope &&
                          entry.name === removing.entry.name && (
                            <ConfigurationConfirmation
                              confirmLabel="Remove configuration"
                              cancelDisabled={busy}
                              confirmDisabled={busy || readFailed}
                              onConfirm={() =>
                                save({
                                  scope: removing.scope,
                                  name: removing.entry.name,
                                  operation: "remove",
                                  revision: file.revision,
                                })
                              }
                              onCancel={configuration.dismiss}
                            >
                              Remove {removing.entry.name} from the{" "}
                              {removing.scope} file?
                              {removing.entry.policyOnly &&
                                " This project will inherit the user configuration again."}{" "}
                              Stored OAuth credentials and running connections
                              are unchanged.
                            </ConfigurationConfirmation>
                          )}
                      </Fragment>
                    );
                  })
                )}
              </section>
            ))}
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
