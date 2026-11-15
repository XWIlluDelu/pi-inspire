import { Plus, Trash2, Undo2 } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import {
  type ConfigurationControl,
  type SecretEdit,
  secretValue,
} from "../../shared/configuration-fields";
import {
  MCP_EXPOSURES,
  MCP_SERVER_NAME,
  type McpConfigEntry,
  type McpConfigScope,
  type McpConfigSnapshot,
  type McpConfigValues,
  type McpConnectionRead,
  type McpConnectionValues,
  mcpOAuthError,
  mcpOAuthFields,
  mcpSecretMaps,
  mcpServerFields,
} from "../../shared/mcp";
import {
  ConfigurationAction,
  ConfigurationForm,
  ConfigurationInput,
  ConfigurationSelect,
  ProtectedConfigurationInput,
  useConfigurationFields,
} from "./ConfigurationForm";
import { DetailSummary } from "./DetailSummary";
import { SettingsSwitch } from "./SettingsControls";

const exposureOptions = MCP_EXPOSURES.map((value) => ({
  value,
  label: value[0]!.toUpperCase() + value.slice(1),
}));
type FieldRow<Value> = {
  id: number;
  key?: string;
  value: Value;
  stored?: boolean;
};

function mapRows<Value>(entries: Record<string, Value>): FieldRow<Value>[] {
  return Object.entries(entries).map(([key, value], id) => ({
    id,
    key,
    value,
  }));
}

type SecretRow = FieldRow<SecretEdit>;
const keepSecret = { kind: "keep" } as const;
function storedSecrets(keys: string[]): SecretRow[] {
  return keys.map((key, id) => ({ id, key, value: keepSecret, stored: true }));
}

function CollectionFields<Value>({
  label,
  keyLabel,
  addLabel,
  rows,
  initialValue,
  busy,
  hint,
  wide,
  children,
  onChange,
  remove,
  valueInput,
}: {
  label: string;
  keyLabel?: string;
  addLabel: string;
  rows?: FieldRow<Value>[];
  initialValue: Value;
  busy: boolean;
  hint?: string;
  wide?: boolean;
  children?: ReactNode;
  onChange: (rows: FieldRow<Value>[]) => void;
  remove: (
    row: FieldRow<Value>,
    index: number,
  ) => {
    label: string;
    restore?: boolean;
    value?: Value;
  };
  valueInput: (
    row: FieldRow<Value>,
    update: (value: Value) => void,
    index: number,
  ) => ReactNode;
}) {
  const fieldset = useRef<HTMLFieldSetElement>(null);
  useLayoutEffect(() => {
    if (!keyLabel || !rows) return;
    const counts = new Map<string, number>();
    for (const { key = "" } of rows)
      counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const input of fieldset.current?.querySelectorAll<HTMLInputElement>(
      "input[data-map-key]",
    ) ?? [])
      input.setCustomValidity(
        (counts.get(input.value) ?? 0) > 1
          ? "Names must be unique within this list."
          : "",
      );
  }, [keyLabel, rows]);
  return (
    <fieldset
      className={wide ? "mcp-fields models-form__wide" : "mcp-fields"}
      ref={fieldset}
    >
      <legend>{label}</legend>
      {hint && <p className="models-status">{hint}</p>}
      {rows?.map((row, index) => {
        const change = (fields: Partial<FieldRow<Value>>) =>
          onChange(
            rows.map((item) =>
              item.id === row.id ? { ...item, ...fields } : item,
            ),
          );
        const action = remove(row, index);
        return (
          <div
            className={keyLabel ? "mcp-row mcp-row--keyed" : "mcp-row"}
            key={row.id}
          >
            {keyLabel && (
              <ConfigurationInput
                label={keyLabel}
                data-map-key
                value={row.key ?? ""}
                required
                disabled={busy || row.stored}
                onChange={(event) => change({ key: event.target.value })}
              />
            )}
            {valueInput(row, (value) => change({ value }), index)}
            <ConfigurationAction
              label={action.label}
              icon={action.restore ? Undo2 : Trash2}
              disabled={busy}
              onClick={() =>
                action.value === undefined
                  ? onChange(rows.filter((item) => item.id !== row.id))
                  : change({ value: action.value })
              }
            />
          </div>
        );
      })}
      {rows && (
        <button
          type="button"
          className="models-text-button"
          disabled={busy}
          onClick={() =>
            onChange([
              ...rows,
              { id: (rows.at(-1)?.id ?? -1) + 1, value: initialValue },
            ])
          }
        >
          <Plus size={13} aria-hidden /> {addLabel}
        </button>
      )}
      {children}
    </fieldset>
  );
}

function SecretMap({
  label,
  rows,
  onChange,
  busy,
}: {
  label: string;
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
  busy: boolean;
}) {
  return (
    <CollectionFields<SecretEdit>
      label={label}
      keyLabel={`${label} name`}
      addLabel={`Add ${label.toLowerCase()}`}
      rows={rows}
      onChange={onChange}
      initialValue={keepSecret}
      busy={busy}
      remove={(row) => {
        const restore = row.value.kind === "remove";
        return {
          label: `${restore ? "Keep" : "Remove"} ${label.toLowerCase()} ${row.key || "entry"}`,
          restore,
          value: row.stored
            ? restore
              ? keepSecret
              : { kind: "remove" }
            : undefined,
        };
      }}
      valueInput={(row, change) => (
        <ConfigurationInput
          label="Value"
          aria-label={`${label} value for ${row.key || "new entry"}`}
          type="password"
          autoComplete="new-password"
          value={secretValue(row.value) ?? ""}
          disabled={busy || row.value.kind === "remove"}
          placeholder={
            row.value.kind === "remove"
              ? "Will be removed"
              : row.stored
                ? "Stored · leave blank to keep"
                : "${ENV_VAR} or a value"
          }
          onChange={(event) =>
            change(
              event.target.value
                ? { kind: "replace", value: event.target.value }
                : keepSecret,
            )
          }
        />
      )}
    />
  );
}

type OAuthField = keyof typeof mcpOAuthFields;
const oauthFields = Object.entries(mcpOAuthFields) as [
  OAuthField,
  { control: ConfigurationControl },
][];
const oauthRegistrationOptions = [
  { value: "auto", label: "Automatic (Pi default)" },
  { value: "dcr", label: "Client ID or dynamic registration" },
  { value: "cimd", label: "Pi metadata document (CIMD)" },
] as const;
const hasOAuthIdentity = (key: string) =>
  key === "clientId" || key === "clientName";

export function McpServerForm({
  entry,
  policyName,
  initialScope,
  snapshot,
  busy,
  readFailed,
  error,
  onSave,
  onReadConnection,
  onCancel,
}: {
  entry: McpConfigEntry | null;
  /** A new policy-only project entry inheriting this user server. */
  policyName?: string;
  initialScope: McpConfigScope;
  snapshot: McpConfigSnapshot;
  busy: boolean;
  readFailed?: boolean;
  error: string | null;
  onSave: (
    scope: McpConfigScope,
    name: string,
    values: McpConfigValues,
  ) => void;
  onReadConnection: (input: McpConnectionRead) => Promise<McpConnectionValues>;
  onCancel: () => void;
}) {
  const policyOnly = Boolean(entry?.policyOnly || policyName);
  const [scope, setScope] = useState(initialScope);
  const [name, setName] = useState(entry?.name ?? policyName ?? "");
  const [transport, setTransport] = useState(entry?.transport ?? "http");
  const [patch, setPatch] = useState<McpConfigValues>({});
  const [secrets, setSecrets] = useState(() => ({
    env: storedSecrets(entry?.envKeys ?? []),
    headers: storedSecrets(entry?.headerKeys ?? []),
  }));
  const file = snapshot.files.find((file) => file.scope === scope)!;
  const [revealed, setRevealed] = useState<{
    revision: string;
    values: McpConnectionValues;
  }>();
  const connection =
    revealed?.revision === file.revision ? revealed.values : undefined;
  const connectionInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (connection) connectionInput.current?.focus();
  }, [connection]);
  const [connectionStatus, setConnectionStatus] = useState<
    "loading" | { error: string }
  >();
  const readingConnection = connectionStatus === "loading";
  const connectionError =
    typeof connectionStatus === "object" ? connectionStatus.error : undefined;
  const connectionOwner = useRef<string | null>(null);
  useLayoutEffect(() => {
    connectionOwner.current = file.revision;
    return () => {
      connectionOwner.current = null;
    };
  }, [file.revision]);
  const args = patch.args ?? connection?.args ?? [];
  const argsHidden = Boolean(entry && !connection && patch.args === undefined);
  const [toolRules, setToolRules] = useState(
    mapRows(entry?.toolExposure ?? {}),
  );
  const hasStoredPrivateValues = Boolean(
    entry &&
      (entry.urlConfigured ||
        entry.argumentCount ||
        entry.envKeys.length ||
        entry.headerKeys.length ||
        entry.oauthFields.length),
  );
  const change = <K extends keyof McpConfigValues>(
    key: K,
    value: McpConfigValues[K],
  ) => setPatch((current) => ({ ...current, [key]: value }));
  const fields = useConfigurationFields(mcpServerFields, entry, busy);
  async function showConnection() {
    if (!entry) return;
    setConnectionStatus("loading");
    const revision = file.revision;
    try {
      const value = await onReadConnection({
        scope,
        name: entry.name,
        revision,
      });
      if (connectionOwner.current === null) return;
      if (connectionOwner.current !== revision)
        throw new Error("Configuration changed. Show the saved values again.");
      setRevealed({ revision, values: value });
      setConnectionStatus(undefined);
    } catch (error) {
      if (connectionOwner.current !== null)
        setConnectionStatus({
          error:
            error instanceof Error
              ? error.message
              : "Saved connection values could not be read.",
        });
    }
  }
  const revealConnection = (label: string) => (
    <button
      type="button"
      className="models-text-button"
      disabled={busy || readingConnection || Boolean(file.error)}
      onClick={() => void showConnection()}
    >
      {readingConnection ? `Loading saved ${label}…` : `Show saved ${label}`}
    </button>
  );
  const enabled = patch.enabled === undefined ? entry?.enabled : patch.enabled;
  const exposure =
    patch.exposure === undefined ? entry?.exposure : patch.exposure;
  const registration =
    patch.oauth?.clientRegistration === null
      ? "auto"
      : (patch.oauth?.clientRegistration ??
        entry?.oauthClientRegistration ??
        "auto");
  // Protected values are not read back. Presence is enough to detect CIMD conflicts;
  // the Host validates the complete merged object, including stored callback URLs.
  const oauth: Record<string, unknown> = {
    ...patch.oauth,
    clientRegistration: registration,
  };
  const secretKey = transport === "http" ? "headers" : "env";
  const secretMap = mcpSecretMaps[secretKey];
  for (const key of ["clientId", "clientName"] as const)
    if (patch.oauth?.[key] === undefined && entry?.oauthFields.includes(key))
      oauth[key] = "stored";
  for (const [key, value] of Object.entries(oauth))
    if (value === null) delete oauth[key];
  const oauthError =
    transport === "http" && !policyOnly ? mcpOAuthError(oauth) : undefined;
  const blocked = Boolean(
    readingConnection || readFailed || file.error || oauthError,
  );
  const toolExposure = Object.fromEntries(
    toolRules.flatMap(({ key, value }) => (key ? [[key, value]] : [])),
  );
  const toolExposureChanged =
    JSON.stringify(toolExposure) !== JSON.stringify(entry?.toolExposure ?? {});
  const unchangedPolicy =
    Boolean(policyName) &&
    !toolExposureChanged &&
    !Object.values(patch).some((value) => value != null);
  const submit = () => {
    if (busy || blocked || unchangedPolicy) return;
    const values = { ...fields.patch(), ...patch };
    if (toolExposureChanged) values.toolExposure = toolExposure;
    const editedSecrets = Object.fromEntries(
      secrets[secretKey].flatMap(({ key, value, stored }) => {
        const change = secretValue(value);
        return key && (change !== undefined || !stored)
          ? [[key, change === undefined ? "" : change]]
          : [];
      }),
    );
    if (Object.keys(editedSecrets).length) values[secretKey] = editedSecrets;
    if (!entry) {
      if (transport === "http") {
        delete values.command;
        delete values.args;
        delete values.cwd;
      } else {
        delete values.url;
        delete values.oauth;
      }
    }
    onSave(scope, name.trim(), values);
  };
  return (
    <ConfigurationForm
      busy={busy}
      error={oauthError ?? connectionError ?? error ?? file.error}
      saveDisabled={blocked || unchangedPolicy}
      pendingLabel="Saving…"
      onSave={submit}
      onCancel={onCancel}
    >
      <div className="models-form__grid">
        {entry || policyName ? (
          <p className="models-status models-form__wide">
            {scope === "user" ? "User configuration" : "Project configuration"}
            {" · "}
            {policyOnly
              ? "Policy override"
              : transport === "http"
                ? "HTTP"
                : "Stdio"}
          </p>
        ) : (
          <>
            <ConfigurationInput
              label="Server name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              pattern={MCP_SERVER_NAME.source}
              disabled={busy}
              autoFocus
              placeholder="project-tools"
            />
            <ConfigurationSelect<McpConfigScope>
              label="Configuration target"
              value={scope}
              disabled={busy}
              options={snapshot.files.map(({ scope }) => ({
                value: scope,
                label:
                  scope === "user" ? "User · all projects" : "This project",
              }))}
              onChange={setScope}
            />
          </>
        )}
        <p className="models-status models-form__wide mcp-path">{file.path}</p>
        {hasStoredPrivateValues ? (
          <p className="models-status models-form__wide mcp-fields-hint">
            Saved connection values are hidden until requested and may contain
            secrets. Blank credential fields keep their saved values.
          </p>
        ) : null}
        {!entry && !policyName && (
          <ConfigurationSelect<"http" | "stdio">
            wide
            label="Transport"
            value={transport}
            disabled={busy}
            options={[
              { value: "http", label: "Streamable HTTP" },
              { value: "stdio", label: "Stdio" },
            ]}
            onChange={setTransport}
          />
        )}
        {policyOnly ? null : transport === "http" ? (
          <div className="models-form__field models-form__wide">
            <ConfigurationInput
              label="Server URL"
              type="text"
              autoComplete="new-password"
              ref={connectionInput}
              value={patch.url ?? connection?.url ?? ""}
              onChange={(event) =>
                change(
                  "url",
                  connection
                    ? event.target.value
                    : event.target.value || undefined,
                )
              }
              required={Boolean(connection) || !entry?.urlConfigured}
              disabled={busy}
              autoFocus={Boolean(entry)}
              placeholder={
                entry?.urlConfigured
                  ? "Stored URL · leave blank to keep"
                  : "https://example.com/mcp"
              }
            />
            {entry?.urlConfigured && !connection && revealConnection("URL")}
          </div>
        ) : (
          <>
            <ConfigurationInput
              {...fields.bind("command")}
              autoFocus={Boolean(entry)}
            />
            <CollectionFields
              wide
              label="Arguments"
              addLabel="Add argument"
              rows={
                argsHidden
                  ? undefined
                  : args.map((value, id) => ({ id, value }))
              }
              hint={
                entry && argsHidden
                  ? `${entry.argumentCount} saved arguments`
                  : entry
                    ? "Edit individual arguments below. An empty list removes them all."
                    : undefined
              }
              initialValue=""
              busy={busy}
              onChange={(rows) =>
                change(
                  "args",
                  rows.map(({ value }) => value),
                )
              }
              remove={(_, index) => ({ label: `Remove argument ${index + 1}` })}
              valueInput={({ value }, update, index) => (
                <ConfigurationInput
                  label={`Argument ${index + 1}`}
                  autoComplete="off"
                  ref={index === 0 ? connectionInput : undefined}
                  value={value}
                  disabled={busy}
                  onChange={(event) => update(event.target.value)}
                />
              )}
            >
              {argsHidden
                ? revealConnection("arguments")
                : entry && (
                    <button
                      type="button"
                      className="models-text-button"
                      disabled={busy}
                      onClick={() => {
                        setRevealed(undefined);
                        change("args", undefined);
                      }}
                    >
                      Keep stored arguments
                    </button>
                  )}
            </CollectionFields>
          </>
        )}
      </div>
      <details className="models-form__optional" open={policyOnly}>
        <DetailSummary>
          {policyOnly ? "Project policy" : "Advanced configuration"}
        </DetailSummary>
        <p className="models-status">
          {policyOnly
            ? "Connection settings come from the user configuration."
            : "Blank credential fields keep saved values."}
        </p>
        <div className="models-form__grid">
          {!policyOnly ? (
            <>
              <ConfigurationInput {...fields.bind("description")} />
              <ConfigurationInput {...fields.bind("timeout")} />
            </>
          ) : null}
          <ConfigurationSelect
            label="Tool exposure"
            autoFocus={policyOnly}
            value={exposure ?? (policyOnly ? "inherit" : "codemode")}
            options={
              policyOnly
                ? [
                    { value: "inherit", label: "Inherit from user" },
                    ...exposureOptions,
                  ]
                : exposureOptions
            }
            disabled={busy}
            onChange={(value) =>
              change("exposure", value === "inherit" ? null : value)
            }
          />
          {policyOnly ? (
            <ConfigurationSelect
              label="Enabled in this project"
              value={
                enabled == null ? "inherit" : enabled ? "enabled" : "disabled"
              }
              options={[
                { value: "inherit", label: "Inherit from user" },
                { value: "enabled", label: "Enabled" },
                { value: "disabled", label: "Disabled" },
              ]}
              disabled={busy}
              onChange={(value) =>
                change(
                  "enabled",
                  value === "inherit" ? null : value === "enabled",
                )
              }
            />
          ) : (
            <div className="models-form__field">
              <span>Enabled in file</span>
              <SettingsSwitch
                label="Enabled in file"
                checked={enabled ?? true}
                disabled={busy}
                onChange={(value) => change("enabled", value)}
              />
            </div>
          )}
          {transport === "stdio" && (
            <ConfigurationInput {...fields.bind("cwd")} />
          )}
        </div>
        {!policyOnly && (
          <SecretMap
            label={secretMap.label}
            rows={secrets[secretKey]}
            onChange={(rows) =>
              setSecrets((current) => ({ ...current, [secretKey]: rows }))
            }
            busy={busy}
          />
        )}
        {!policyOnly && transport === "http" && (
          <details className="models-form__optional">
            <DetailSummary>OAuth client configuration</DetailSummary>
            <p className="models-status">
              HTTP servers can use Pi's automatic OAuth discovery. Configure
              these only when the server needs them; saving does not sign in.
            </p>
            <div className="models-form__grid">
              <ConfigurationSelect
                wide
                label="Client registration"
                value={registration}
                disabled={busy}
                options={oauthRegistrationOptions}
                onChange={(clientRegistration) =>
                  change("oauth", { ...patch.oauth, clientRegistration })
                }
              />
              {registration === "cimd" ? (
                <p className="models-status models-form__wide">
                  Uses Pi's client metadata document instead of a client ID or
                  name. A custom callback must use localhost or 127.0.0.1 with
                  the path /callback.
                </p>
              ) : null}
              {oauthFields
                .filter(
                  ([key]) =>
                    registration !== "cimd" ||
                    !hasOAuthIdentity(key) ||
                    oauth[key] !== undefined ||
                    entry?.oauthFields.includes(key),
                )
                .map(([key, { control }]) => (
                  <ProtectedConfigurationInput
                    key={key}
                    control={control}
                    value={patch.oauth?.[key]}
                    busy={busy}
                    stored={entry?.oauthFields.includes(key)}
                    onChange={(edit) =>
                      change("oauth", {
                        ...patch.oauth,
                        [key]: secretValue(edit),
                      })
                    }
                  />
                ))}
            </div>
          </details>
        )}
        <CollectionFields
          label="Per-tool exposure"
          keyLabel="Tool name or pattern"
          hint="Use exact tool names or * patterns. Exact names win; patterns match in order."
          addLabel="Add tool rule"
          rows={toolRules}
          initialValue="codemode"
          busy={busy}
          onChange={setToolRules}
          remove={(_, index) => ({ label: `Remove tool rule ${index + 1}` })}
          valueInput={(rule, change) => (
            <ConfigurationSelect
              caption="Exposure"
              label={`Exposure for ${rule.key || "new rule"}`}
              value={rule.value}
              options={exposureOptions}
              disabled={busy}
              onChange={change}
            />
          )}
        />
      </details>
      {scope === "project" ? (
        <p className="models-status">
          Pi uses project configuration only when the project is trusted.
        </p>
      ) : null}
      {entry?.extraFieldCount ? (
        <p className="models-status">
          {entry.extraFieldCount} additional fields will be preserved.
        </p>
      ) : null}
    </ConfigurationForm>
  );
}
