import { Plus, Trash2, Undo2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import {
  MCP_EXPOSURES,
  type McpConfigEntry,
  type McpConfigScope,
  type McpConfigSnapshot,
  type McpConfigValues,
  type McpExposure,
} from "../../shared/mcp";
import { Dropdown } from "./Dropdown";
import { SettingsSwitch } from "./SettingsControls";

const exposureOptions = MCP_EXPOSURES.map((value) => ({
  value,
  label:
    value === "codemode"
      ? "Codemode"
      : value[0]!.toUpperCase() + value.slice(1),
}));
type Pair = {
  id: number;
  key: string;
  value: string;
  stored: boolean;
  removed: boolean;
};
function validateUniqueKeys(fieldset: HTMLFieldSetElement | null) {
  const inputs = [
    ...(fieldset?.querySelectorAll<HTMLInputElement>("input[data-map-key]") ??
      []),
  ];
  const keys = inputs.map((input) => input.value);
  for (const input of inputs)
    input.setCustomValidity(
      keys.filter((key) => key === input.value).length > 1
        ? "Names must be unique within this list."
        : "",
    );
}
function storedPairs(keys: string[]): Pair[] {
  return keys.map((key, id) => ({
    id,
    key,
    value: "",
    stored: true,
    removed: false,
  }));
}
/** Values are write-only. Empty replacement means keep; deletion is always explicit. */
function SecretMap({
  label,
  rows,
  onChange,
  busy,
}: {
  label: string;
  rows: Pair[];
  onChange: (rows: Pair[]) => void;
  busy: boolean;
}) {
  const fieldset = useRef<HTMLFieldSetElement>(null);
  useLayoutEffect(() => validateUniqueKeys(fieldset.current), [rows]);
  return (
    <fieldset className="mcp-fields" ref={fieldset}>
      <legend>{label}</legend>
      {rows.map((row) => (
        <div className="mcp-pair" key={row.id}>
          <label>
            Name
            <input
              aria-label={`${label} name`}
              data-map-key
              value={row.key}
              required={!row.removed}
              disabled={busy || row.stored}
              onChange={(event) =>
                onChange(
                  rows.map((item) =>
                    item.id === row.id
                      ? { ...item, key: event.target.value }
                      : item,
                  ),
                )
              }
            />
          </label>
          <label>
            Value
            <input
              aria-label={`${label} value for ${row.key || "new entry"}`}
              type="password"
              autoComplete="new-password"
              value={row.value}
              disabled={busy || row.removed}
              placeholder={
                row.removed
                  ? "Will be removed"
                  : row.stored
                    ? "Stored · leave blank to keep"
                    : "${ENV_VAR} or a value"
              }
              onChange={(event) =>
                onChange(
                  rows.map((item) =>
                    item.id === row.id
                      ? { ...item, value: event.target.value }
                      : item,
                  ),
                )
              }
            />
          </label>
          <button
            type="button"
            className="models-icon-button"
            aria-label={`${row.removed ? "Keep" : "Remove"} ${label.toLowerCase()} ${row.key || "entry"}`}
            disabled={busy}
            onClick={() =>
              onChange(
                row.stored
                  ? rows.map((item) =>
                      item.id === row.id
                        ? { ...item, removed: !item.removed, value: "" }
                        : item,
                    )
                  : rows.filter((item) => item.id !== row.id),
              )
            }
          >
            {row.removed ? (
              <Undo2 size={14} aria-hidden />
            ) : (
              <Trash2 size={14} aria-hidden />
            )}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="models-text-button"
        disabled={busy}
        onClick={() =>
          onChange([
            ...rows,
            {
              id: (rows.at(-1)?.id ?? -1) + 1,
              key: "",
              value: "",
              stored: false,
              removed: false,
            },
          ])
        }
      >
        <Plus size={13} aria-hidden /> Add {label.toLowerCase()}
      </button>
    </fieldset>
  );
}
const oauthLabels = [
  ["clientId", "Client ID"],
  ["clientSecret", "Client secret"],
  ["clientName", "Client name"],
  ["callbackUrl", "Callback URL"],
  ["callbackPort", "Callback port"],
  ["scope", "OAuth scope"],
  ["authServerMetadataUrl", "Authorization server metadata URL"],
] as const;

export function McpServerForm({
  entry,
  initialScope,
  snapshot,
  busy,
  error,
  onSave,
  onCancel,
}: {
  entry: McpConfigEntry | null;
  initialScope: McpConfigScope;
  snapshot: McpConfigSnapshot;
  busy: boolean;
  error: string | null;
  onSave: (
    scope: McpConfigScope,
    name: string,
    values: McpConfigValues,
  ) => void;
  onCancel: () => void;
}) {
  const [scope, setScope] = useState(initialScope);
  const [name, setName] = useState(entry?.name ?? "");
  const [transport, setTransport] = useState(entry?.transport ?? "http");
  const [patch, setPatch] = useState<McpConfigValues>({});
  const [envRows, setEnvRows] = useState(() =>
    storedPairs(entry?.envKeys ?? []),
  );
  const [headerRows, setHeaderRows] = useState(() =>
    storedPairs(entry?.headerKeys ?? []),
  );
  const [replaceArgs, setReplaceArgs] = useState(false);
  const [args, setArgs] = useState<string[]>([]);
  const [toolRules, setToolRules] = useState(
    Object.entries(entry?.toolExposure ?? {}).map(([key, value]) => ({
      key,
      value,
    })),
  );
  const hasStoredPrivateValues = Boolean(
    entry &&
      (entry.urlConfigured ||
        entry.argumentCount ||
        entry.envKeys.length ||
        entry.headerKeys.length ||
        entry.oauthFields.length),
  );
  const ruleFields = useRef<HTMLFieldSetElement>(null);
  useLayoutEffect(() => validateUniqueKeys(ruleFields.current), [toolRules]);
  const change = <K extends keyof McpConfigValues>(
    key: K,
    value: McpConfigValues[K],
  ) => setPatch((current) => ({ ...current, [key]: value }));
  const file = snapshot.files.find((file) => file.scope === scope)!;
  const enabled = patch.enabled === undefined ? entry?.enabled : patch.enabled;
  const exposure =
    patch.exposure === undefined ? entry?.exposure : patch.exposure;
  const rulesChanged = (rules: typeof toolRules) => {
    setToolRules(rules);
    change(
      "toolExposure",
      Object.fromEntries(
        rules.filter((rule) => rule.key).map((rule) => [rule.key, rule.value]),
      ),
    );
  };
  return (
    <form
      className="models-form"
      onSubmit={(event) => {
        event.preventDefault();
        const values = { ...patch };
        const secrets = Object.fromEntries(
          (transport === "http" ? headerRows : envRows).flatMap((row) =>
            row.key && (row.removed || row.value || !row.stored)
              ? [[row.key, row.removed ? null : row.value]]
              : [],
          ),
        );
        if (Object.keys(secrets).length)
          values[transport === "http" ? "headers" : "env"] = secrets;
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
      }}
    >
      <div className="models-form__body">
        <div className="models-form__grid">
          {entry ? (
            <p className="models-status models-form__wide">
              {scope === "user"
                ? "User configuration"
                : "Project configuration"}
              {" · "}
              {entry.policyOnly
                ? "Policy override"
                : transport === "http"
                  ? "HTTP"
                  : "Stdio"}
            </p>
          ) : (
            <>
              <label>
                Server name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  pattern="[A-Za-z0-9_-]+"
                  disabled={busy}
                  autoFocus
                  placeholder="project-tools"
                />
              </label>
              <div className="models-form__field">
                <span>Configuration target</span>
                <Dropdown
                  className="dropdown--field"
                  label="Configuration target"
                  value={scope}
                  disabled={busy}
                  options={[
                    { value: "user", label: "User · all projects" },
                    { value: "project", label: "This project" },
                  ]}
                  onChange={(value) => setScope(value as McpConfigScope)}
                />
              </div>
            </>
          )}
          <p className="models-status models-form__wide mcp-path">
            {file.path}
          </p>
          {hasStoredPrivateValues ? (
            <p className="models-status models-form__wide mcp-fields-hint">
              Stored values stay on the Host. Leave protected fields blank to
              keep them; use their remove actions to clear them.
            </p>
          ) : null}
          {!entry && (
            <div className="models-form__field models-form__wide">
              <span>Transport</span>
              <Dropdown
                className="dropdown--field"
                label="Transport"
                value={transport}
                disabled={busy}
                options={[
                  { value: "http", label: "Streamable HTTP" },
                  { value: "stdio", label: "Stdio" },
                ]}
                onChange={(value) => setTransport(value as "http" | "stdio")}
              />
            </div>
          )}
          {entry?.policyOnly ? null : transport === "http" ? (
            <label className="models-form__wide">
              Server URL
              <input
                type="text"
                autoComplete="new-password"
                value={patch.url ?? ""}
                onChange={(event) =>
                  change("url", event.target.value || undefined)
                }
                required={!entry?.urlConfigured}
                disabled={busy}
                autoFocus={Boolean(entry)}
                placeholder={
                  entry?.urlConfigured
                    ? "Stored URL · leave blank to keep"
                    : "https://example.com/mcp"
                }
              />
            </label>
          ) : (
            <>
              <label className="models-form__wide">
                Program
                <input
                  value={patch.command ?? entry?.command ?? ""}
                  onChange={(event) => change("command", event.target.value)}
                  required
                  disabled={busy}
                  autoFocus={Boolean(entry)}
                  placeholder="npx"
                />
              </label>
              <fieldset className="mcp-fields models-form__wide">
                <legend>Arguments</legend>
                {entry && !replaceArgs ? (
                  <>
                    <p className="models-status">
                      {entry.argumentCount} saved arguments
                    </p>
                    <button
                      type="button"
                      className="models-text-button"
                      disabled={busy}
                      onClick={() => {
                        setReplaceArgs(true);
                        change("args", []);
                      }}
                    >
                      Replace arguments
                    </button>
                  </>
                ) : (
                  <>
                    {entry ? (
                      <p className="models-status">
                        Replaces all stored arguments. An empty list removes
                        them.
                      </p>
                    ) : null}
                    {args.map((arg, index) => (
                      <div className="mcp-argument" key={index}>
                        <label>
                          Argument {index + 1}
                          <input
                            type="text"
                            autoComplete="off"
                            value={arg}
                            disabled={busy}
                            onChange={(event) => {
                              const next = args.map((value, i) =>
                                i === index ? event.target.value : value,
                              );
                              setArgs(next);
                              change("args", next);
                            }}
                          />
                        </label>
                        <button
                          type="button"
                          className="models-icon-button"
                          aria-label={`Remove argument ${index + 1}`}
                          disabled={busy}
                          onClick={() => {
                            const next = args.filter((_, i) => i !== index);
                            setArgs(next);
                            change("args", next);
                          }}
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="models-text-button"
                      disabled={busy}
                      onClick={() => {
                        const next = [...args, ""];
                        setArgs(next);
                        change("args", next);
                      }}
                    >
                      Add argument
                    </button>
                    {entry ? (
                      <button
                        type="button"
                        className="models-text-button"
                        disabled={busy}
                        onClick={() => {
                          setReplaceArgs(false);
                          setArgs([]);
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
        <details className="models-form__optional" open={entry?.policyOnly}>
          <summary>
            {entry?.policyOnly ? "Project policy" : "Advanced configuration"}
          </summary>
          <p className="models-status">
            {entry?.policyOnly
              ? "Connection settings come from the user configuration."
              : "Blank credential fields keep saved values."}
          </p>
          <div className="models-form__grid">
            {!entry?.policyOnly ? (
              <>
                <label className="models-form__wide">
                  Description
                  <input
                    value={
                      patch.description === null
                        ? ""
                        : (patch.description ?? entry?.description ?? "")
                    }
                    onChange={(event) =>
                      change("description", event.target.value || null)
                    }
                    disabled={busy}
                  />
                </label>
                <label>
                  Timeout (seconds)
                  <input
                    type="number"
                    min="0.001"
                    step="any"
                    placeholder="60"
                    value={
                      patch.timeout === null
                        ? ""
                        : (patch.timeout ?? entry?.timeout ?? "")
                    }
                    disabled={busy}
                    onChange={(event) =>
                      change(
                        "timeout",
                        event.target.value ? Number(event.target.value) : null,
                      )
                    }
                  />
                </label>
              </>
            ) : null}
            <div className="models-form__field">
              <span>Tool exposure</span>
              <Dropdown
                className="dropdown--field"
                label="Tool exposure"
                autoFocus={Boolean(entry?.policyOnly)}
                value={exposure ?? (entry?.policyOnly ? "inherit" : "codemode")}
                options={
                  entry?.policyOnly
                    ? [
                        { value: "inherit", label: "Inherit from user" },
                        ...exposureOptions,
                      ]
                    : exposureOptions
                }
                disabled={busy}
                onChange={(value) =>
                  change(
                    "exposure",
                    value === "inherit" ? null : (value as McpExposure),
                  )
                }
              />
            </div>
            <div className="models-form__field">
              <span>
                {entry?.policyOnly
                  ? "Enabled in this project"
                  : "Enabled in file"}
              </span>
              {entry?.policyOnly ? (
                <Dropdown
                  className="dropdown--field"
                  label="Enabled in this project"
                  value={
                    enabled === null
                      ? "inherit"
                      : enabled
                        ? "enabled"
                        : "disabled"
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
            {transport === "stdio" ? (
              <label className="models-form__wide">
                Working directory
                <input
                  value={
                    patch.cwd === null ? "" : (patch.cwd ?? entry?.cwd ?? "")
                  }
                  disabled={busy}
                  onChange={(event) =>
                    change("cwd", event.target.value || null)
                  }
                  placeholder="Relative to the session directory"
                />
              </label>
            ) : null}
          </div>
          {entry?.policyOnly ? null : transport === "stdio" ? (
            <SecretMap
              label="Environment variable"
              rows={envRows}
              onChange={setEnvRows}
              busy={busy}
            />
          ) : (
            <>
              <SecretMap
                label="Header"
                rows={headerRows}
                onChange={setHeaderRows}
                busy={busy}
              />
              <details className="models-form__optional">
                <summary>OAuth client configuration</summary>
                <p className="models-status">
                  HTTP servers can use Pi's automatic OAuth discovery. Configure
                  these only when the server needs them; saving does not sign
                  in.
                </p>
                <div className="models-form__grid">
                  {oauthLabels.map(([key, label]) => (
                    <div className="models-form__field" key={key}>
                      <label>
                        {label}
                        <input
                          type={
                            key === "callbackPort"
                              ? "number"
                              : key === "clientSecret"
                                ? "password"
                                : "text"
                          }
                          autoComplete="new-password"
                          value={patch.oauth?.[key] ?? ""}
                          min={key === "callbackPort" ? 1 : undefined}
                          max={key === "callbackPort" ? 65535 : undefined}
                          disabled={busy || patch.oauth?.[key] === null}
                          placeholder={
                            entry?.oauthFields.includes(key)
                              ? "Stored · leave blank to keep"
                              : "Optional"
                          }
                          onChange={(event) =>
                            change("oauth", {
                              ...patch.oauth,
                              [key]: event.target.value
                                ? key === "callbackPort"
                                  ? Number(event.target.value)
                                  : event.target.value
                                : undefined,
                            })
                          }
                        />
                      </label>
                      {entry?.oauthFields.includes(key) ? (
                        <label className="models-checkbox">
                          <input
                            type="checkbox"
                            className="choice-input"
                            disabled={busy}
                            checked={patch.oauth?.[key] === null}
                            onChange={(event) =>
                              change("oauth", {
                                ...patch.oauth,
                                [key]: event.target.checked ? null : undefined,
                              })
                            }
                          />
                          Remove {label.toLowerCase()}
                        </label>
                      ) : null}
                    </div>
                  ))}
                </div>
              </details>
            </>
          )}
          <fieldset className="mcp-fields" ref={ruleFields}>
            <legend>Per-tool exposure</legend>
            <p className="models-status">
              Use exact tool names or * patterns. Exact names win; patterns
              match in order.
            </p>
            {toolRules.map((rule, index) => (
              <div className="mcp-pair" key={index}>
                <label>
                  Tool name or pattern
                  <input
                    value={rule.key}
                    data-map-key
                    required
                    disabled={busy}
                    onChange={(event) =>
                      rulesChanged(
                        toolRules.map((item, i) =>
                          i === index
                            ? { ...item, key: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <div className="models-form__field">
                  <span>Exposure</span>
                  <Dropdown
                    className="dropdown--field"
                    label={`Exposure for ${rule.key || "new rule"}`}
                    value={rule.value}
                    options={exposureOptions}
                    disabled={busy}
                    onChange={(value) =>
                      rulesChanged(
                        toolRules.map((item, i) =>
                          i === index
                            ? { ...item, value: value as McpExposure }
                            : item,
                        ),
                      )
                    }
                  />
                </div>
                <button
                  type="button"
                  className="models-icon-button"
                  aria-label={`Remove tool rule ${index + 1}`}
                  disabled={busy}
                  onClick={() =>
                    rulesChanged(toolRules.filter((_, i) => i !== index))
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
              onClick={() =>
                rulesChanged([...toolRules, { key: "", value: "codemode" }])
              }
            >
              Add tool rule
            </button>
          </fieldset>
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
        {file.error || error ? (
          <p className="settings__error" role="alert">
            {error ?? file.error}
          </p>
        ) : null}
      </div>
      <div className="models-actions models-form__actions">
        <button
          type="submit"
          className="button button--primary"
          disabled={busy || Boolean(file.error)}
        >
          {busy ? "Saving…" : "Save configuration"}
        </button>
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
