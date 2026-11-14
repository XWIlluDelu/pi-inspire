import { Plus, RefreshCw, Server } from "lucide-react";
import { useEffect, useState } from "react";
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
import { NativeSelect } from "./NativeSelect";
import { SettingsCardMessage, SettingsSection } from "./SettingsSection";

const serverKey = (scope: McpConfigScope, name: string) =>
  JSON.stringify([scope, name]);
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
    selected: selectedServer,
    select: selectServer,
  } = configuration;
  const editor = selection?.kind === "edit" ? selection : null;
  const removing = selection?.kind === "remove" ? selection : null;
  const [saved, setSaved] = useState<string | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const { cwd, sessionId } = owner;
  const read = () => load(() => store.readMcpConfig(owner));
  useEffect(() => {
    if (active && !snapshot && !readFailed)
      void load(() =>
        store.readMcpConfig(sessionId ? { sessionId } : cwd ? { cwd } : {}),
      );
  }, [active, cwd, load, readFailed, sessionId, snapshot]);
  const open = (next: Selection, opener: HTMLElement) => {
    configuration.open(next, opener, next.kind === "edit");
    setConfirmReload(false);
  };
  const projectFile = snapshot?.files.find((file) => file.scope === "project");
  const servers =
    snapshot?.files.flatMap((file) =>
      file.entries.map((entry) => ({
        file,
        entry,
        key: serverKey(file.scope, entry.name),
      })),
    ) ?? [];
  const detail = servers.find(({ key }) => key === selectedServer);
  const entry = detail?.entry;
  const scope = detail?.file.scope;
  const hasOverride = projectFile?.entries.some(
    ({ name }) => name === entry?.name,
  );
  const customize =
    scope === "user" &&
    entry?.transport &&
    projectFile &&
    !projectFile.error &&
    !hasOverride;
  function save(edit: McpConfigEdit) {
    void write(() => store.editMcpConfig(owner, edit), {
      close: true,
      onSaved: (result) => {
        setSaved(
          result.warning ??
            "Saved to file. Running sessions have not been reloaded.",
        );
        if (edit.operation !== "update")
          selectServer(
            edit.operation === "remove"
              ? undefined
              : serverKey(edit.scope, edit.name),
          );
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
  function reload() {
    setError(null);
    const current = store.getState();
    if (
      current.sessionId !== owner.sessionId ||
      current.readOnlyReason ||
      (current.sessionId &&
        current.sessionStatuses[current.sessionId]?.external) ||
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
    setSaved("Reload requested. Check its result in the conversation.");
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
          description="Saved MCP settings apply in new or reloaded sessions."
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
              <ConfigurationConfirmation
                primary
                confirmLabel="Reload Pi resources"
                cancelLabel="Cancel reload"
                confirmDisabled={!canReload || reloadBlocked || busy}
                onConfirm={reload}
                onCancel={() => setConfirmReload(false)}
              >
                Reload Pi in the selected session. Unsaved extension state may
                be lost.
              </ConfigurationConfirmation>
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
                <h4>
                  {file.scope === "user" ? "User" : "Project"} configuration
                </h4>
                <span className="mcp-path">{file.path}</span>
                {file.error ? (
                  <p className="settings__error" role="alert">
                    {file.error}
                  </p>
                ) : (
                  !file.entries.length && (
                    <p className="models-status">No servers in this file.</p>
                  )
                )}
              </section>
            ))}
            {servers.length > 0 && (
              <NativeSelect
                className="native-select--field configuration-selection"
                label="MCP server"
                value={detail?.key ?? ""}
                display={detail ? undefined : "Choose MCP server"}
                options={servers.map(({ file, entry, key }) => ({
                  value: key,
                  label: `${entry.name} · ${file.scope}`,
                }))}
                disabled={busy}
                onChange={(key) => {
                  if (removing) configuration.dismiss();
                  selectServer(key);
                }}
              />
            )}
            {detail && entry && scope && (
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
                  open({ kind: "remove", scope, entry }, event.currentTarget)
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
            )}
            {removing &&
              detail?.file.scope === removing.scope &&
              detail.entry.name === removing.entry.name && (
                <ConfigurationConfirmation
                  confirmLabel="Remove configuration"
                  cancelDisabled={busy}
                  confirmDisabled={busy || readFailed}
                  onConfirm={() =>
                    save({
                      scope: removing.scope,
                      name: removing.entry.name,
                      operation: "remove",
                      revision: detail.file.revision,
                    })
                  }
                  onCancel={configuration.dismiss}
                >
                  Remove {removing.entry.name} from the {removing.scope} file?
                  {removing.entry.policyOnly &&
                    " This project will inherit the user configuration again."}{" "}
                  Stored OAuth credentials and running connections are
                  unchanged.
                </ConfigurationConfirmation>
              )}
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
