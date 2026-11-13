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
  ConfigurationForm,
  ConfigurationInput,
  ProtectedConfigurationInput,
} from "./ConfigurationForm";
import { DetailSummary } from "./DetailSummary";
import { NativeSelect } from "./NativeSelect";
import { SettingsSwitch } from "./SettingsControls";

const exposureOptions = MCP_EXPOSURES.map((value) => ({
  value,
  label: value[0]!.toUpperCase() + value.slice(1),
}));
type MapRow<Value> = {
  id: number;
  key: string;
  value: Value;
  stored?: boolean;
};

function mapRows<Value>(entries: Record<string, Value>): MapRow<Value>[] {
  return Object.entries(entries).map(([key, value], id) => ({
    id,
    key,
    value,
  }));
}

type SecretRow = MapRow<SecretEdit>;
const keepSecret = { kind: "keep" } as const;
function storedSecrets(keys: string[]): SecretRow[] {
  return keys.map((key, id) => ({ id, key, value: keepSecret, stored: true }));
}

function MapFields<Value>({
  label,
  keyLabel,
  addLabel,
  rows,
  initialValue,
  busy,
  hint,
  onChange,
  remove,
  valueInput,
}: {
  label: string;
  keyLabel: string;
  addLabel: string;
  rows: MapRow<Value>[];
  initialValue: Value;
  busy: boolean;
  hint?: string;
  onChange: (rows: MapRow<Value>[]) => void;
  remove: (
    row: MapRow<Value>,
    index: number,
  ) => {
    label: string;
    restore?: boolean;
    value?: Value;
  };
  valueInput: (row: MapRow<Value>, update: (value: Value) => void) => ReactNode;
}) {
  const fieldset = useRef<HTMLFieldSetElement>(null);
  useLayoutEffect(() => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
    for (const input of fieldset.current?.querySelectorAll<HTMLInputElement>(
      "input[data-map-key]",
    ) ?? [])
      input.setCustomValidity(
        (counts.get(input.value) ?? 0) > 1
          ? "Names must be unique within this list."
          : "",
      );
  }, [rows]);
  const change = (id: number, fields: Partial<MapRow<Value>>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...fields } : row)));
  return (
    <fieldset className="mcp-fields" ref={fieldset}>
      <legend>{label}</legend>
      {hint && <p className="models-status">{hint}</p>}
      {rows.map((row, index) => {
        const action = remove(row, index);
        const Icon = action.restore ? Undo2 : Trash2;
        return (
          <div className="mcp-pair" key={row.id}>
            <ConfigurationInput
              label={keyLabel}
              aria-label={keyLabel}
              data-map-key
              value={row.key}
              required
              disabled={busy || row.stored}
              onChange={(event) => change(row.id, { key: event.target.value })}
            />
            {valueInput(row, (value) => change(row.id, { value }))}
            <button
              type="button"
              className="models-icon-button"
              aria-label={action.label}
              disabled={busy}
              onClick={() =>
                action.value === undefined
                  ? onChange(rows.filter((item) => item.id !== row.id))
                  : change(row.id, { value: action.value })
              }
            >
              <Icon size={14} aria-hidden />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="models-text-button"
        disabled={busy}
        onClick={() =>
          onChange([
            ...rows,
            { id: (rows.at(-1)?.id ?? -1) + 1, key: "", value: initialValue },
          ])
        }
      >
        <Plus size={13} aria-hidden /> {addLabel}
      </button>
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
    <MapFields<SecretEdit>
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
  const [connection, setConnection] = useState<McpConnectionValues | null>(
    null,
  );
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
  const file = snapshot.files.find((file) => file.scope === scope)!;
  useLayoutEffect(() => {
    connectionOwner.current = file.revision;
    return () => {
      connectionOwner.current = null;
    };
  }, [file.revision]);
  const args = patch.args ?? connection?.args ?? [];
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
  const fields = <Key extends keyof typeof mcpServerFields>(key: Key) => {
    const { control } = mcpServerFields[key];
    return {
      ...control,
      disabled: busy,
      value: patch[key] === null ? "" : (patch[key] ?? entry?.[key] ?? ""),
      onChange: ({
        currentTarget: input,
      }: React.ChangeEvent<HTMLInputElement>) =>
        change(
          key,
          (input.value
            ? control.type === "number"
              ? input.valueAsNumber
              : input.value
            : control.required
              ? ""
              : null) as McpConfigValues[Key],
        ),
    };
  };
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
      setConnection(value);
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
  const unchangedPolicy =
    Boolean(policyName) && !Object.values(patch).some((value) => value != null);
  const rulesChanged = (rules: typeof toolRules) => {
    setToolRules(rules);
    const toolExposure = Object.fromEntries(
      rules.filter((rule) => rule.key).map((rule) => [rule.key, rule.value]),
    );
    setPatch((current) => {
      const next = { ...current };
      if (
        JSON.stringify(toolExposure) ===
        JSON.stringify(entry?.toolExposure ?? {})
      )
        delete next.toolExposure;
      else next.toolExposure = toolExposure;
      return next;
    });
  };
  const submit = () => {
    if (busy || blocked || unchangedPolicy) return;
    const values = { ...patch };
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
            <div className="models-form__field">
              <span>Configuration target</span>
              <NativeSelect<McpConfigScope>
                className="native-select--field"
                label="Configuration target"
                value={scope}
                disabled={busy}
                options={snapshot.files.map((file) => ({
                  value: file.scope,
                  label:
                    file.scope === "user"
                      ? "User · all projects"
                      : "This project",
                }))}
                onChange={setScope}
              />
            </div>
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
          <div className="models-form__field models-form__wide">
            <span>Transport</span>
            <NativeSelect<"http" | "stdio">
              className="native-select--field"
              label="Transport"
              value={transport}
              disabled={busy}
              options={
                [
                  { value: "http", label: "Streamable HTTP" },
                  { value: "stdio", label: "Stdio" },
                ] as const
              }
              onChange={setTransport}
            />
          </div>
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
              {...fields("command")}
              autoFocus={Boolean(entry)}
            />
            <fieldset className="mcp-fields models-form__wide">
              <legend>Arguments</legend>
              {entry && !connection ? (
                <>
                  <p className="models-status">
                    {entry.argumentCount} saved arguments
                  </p>
                  {revealConnection("arguments")}
                </>
              ) : (
                <>
                  {entry ? (
                    <p className="models-status">
                      Edit individual arguments below. An empty list removes
                      them all.
                    </p>
                  ) : null}
                  {args.map((arg, index) => (
                    <div className="mcp-argument" key={index}>
                      <ConfigurationInput
                        label={`Argument ${index + 1}`}
                        type="text"
                        autoComplete="off"
                        ref={index === 0 ? connectionInput : undefined}
                        value={arg}
                        disabled={busy}
                        onChange={(event) =>
                          change(
                            "args",
                            args.map((value, i) =>
                              i === index ? event.target.value : value,
                            ),
                          )
                        }
                      />
                      <button
                        type="button"
                        className="models-icon-button"
                        aria-label={`Remove argument ${index + 1}`}
                        disabled={busy}
                        onClick={() =>
                          change(
                            "args",
                            args.filter((_, i) => i !== index),
                          )
                        }
                      >
                        <Trash2 size={14} aria-hidden />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="models-text-button"
                    disabled={busy}
                    onClick={() => change("args", [...args, ""])}
                  >
                    Add argument
                  </button>
                  {entry ? (
                    <button
                      type="button"
                      className="models-text-button"
                      disabled={busy}
                      onClick={() => {
                        setConnection(null);
                        change("args", undefined);
                      }}
                    >
                      Keep stored arguments
                    </button>
                  ) : null}
                </>
              )}
            </fieldset>
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
              <ConfigurationInput {...fields("description")} />
              <ConfigurationInput {...fields("timeout")} />
            </>
          ) : null}
          <div className="models-form__field">
            <span>Tool exposure</span>
            <NativeSelect
              className="native-select--field"
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
          </div>
          <div className="models-form__field">
            <span>
              {policyOnly ? "Enabled in this project" : "Enabled in file"}
            </span>
            {policyOnly ? (
              <NativeSelect
                className="native-select--field"
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
              <SettingsSwitch
                label="Enabled in file"
                checked={enabled ?? true}
                disabled={busy}
                onChange={(value) => change("enabled", value)}
              />
            )}
          </div>
          {transport === "stdio" && <ConfigurationInput {...fields("cwd")} />}
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
              <div className="models-form__field models-form__wide">
                <span>Client registration</span>
                <NativeSelect
                  className="native-select--field"
                  label="Client registration"
                  value={registration}
                  disabled={busy}
                  options={oauthRegistrationOptions}
                  onChange={(value) =>
                    change("oauth", {
                      ...patch.oauth,
                      clientRegistration: value,
                    })
                  }
                />
              </div>
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
        <MapFields
          label="Per-tool exposure"
          keyLabel="Tool name or pattern"
          hint="Use exact tool names or * patterns. Exact names win; patterns match in order."
          addLabel="Add tool rule"
          rows={toolRules}
          initialValue="codemode"
          busy={busy}
          onChange={rulesChanged}
          remove={(_, index) => ({ label: `Remove tool rule ${index + 1}` })}
          valueInput={(rule, change) => (
            <div className="models-form__field">
              <span>Exposure</span>
              <NativeSelect
                className="native-select--field"
                label={`Exposure for ${rule.key || "new rule"}`}
                value={rule.value}
                options={exposureOptions}
                disabled={busy}
                onChange={change}
              />
            </div>
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
      {file.error || error || oauthError || connectionError ? (
        <p className="settings__error" role="alert">
          {oauthError ?? connectionError ?? error ?? file.error}
        </p>
      ) : null}
    </ConfigurationForm>
  );
}
