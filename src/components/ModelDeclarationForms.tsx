import { Eye, EyeOff } from "lucide-react";
import { type FormEvent, useState } from "react";
import type {
  ModelConfigEdit,
  ModelDeclaration,
  ProviderDeclaration,
} from "../../shared/model-settings";

export function ProviderForm({
  value,
  onSave,
  onCancel,
  busy,
  nativeApiProviders,
  error,
}: {
  value: ProviderDeclaration | null;
  onSave: (edit: ModelConfigEdit) => Promise<boolean>;
  onCancel: () => void;
  busy: boolean;
  nativeApiProviders: readonly string[];
  error?: string | null;
}) {
  const [id, setId] = useState(value?.id ?? "");
  const [baseUrl, setBaseUrl] = useState(value?.baseUrl ?? "");
  const [api, setApi] = useState(value?.api ?? "");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [removeKey, setRemoveKey] = useState(false);
  const hasNativeApi = nativeApiProviders.includes(value?.id ?? id.trim());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const values: Extract<ModelConfigEdit, { kind: "provider" }>["values"] = {};
    if (baseUrl !== (value?.baseUrl ?? ""))
      values.baseUrl = baseUrl.trim() || null;
    if (api !== (value?.api ?? "")) values.api = api.trim() || null;
    if (key) values.apiKey = key;
    else if (removeKey) values.apiKey = null;
    await onSave({ kind: "provider", id: value?.id ?? id.trim(), values });
  };
  return (
    <form className="models-form" onSubmit={(event) => void submit(event)}>
      <h4>{value ? `Edit ${value.id}` : "Add provider"}</h4>
      <div className="models-form__grid">
        <label>
          Provider ID
          <input
            required
            value={id}
            disabled={Boolean(value) || busy}
            onChange={(event) => setId(event.target.value)}
            placeholder="my-provider"
            autoFocus={!value}
          />
        </label>
        <label>
          Base URL
          <input
            value={baseUrl}
            disabled={busy}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com/v1"
            autoFocus={Boolean(value)}
          />
        </label>
        <label>
          API type
          <input
            aria-label="API type"
            value={api}
            disabled={busy}
            onChange={(event) => setApi(event.target.value)}
            placeholder={
              hasNativeApi ? "Use default" : "Set here or on the model"
            }
          />
        </label>
        <label className="models-form__wide">
          API key
          <div className="models-secret-input">
            <input
              type={showKey ? "text" : "password"}
              value={key}
              disabled={busy}
              autoComplete="new-password"
              onChange={(event) => {
                setKey(event.target.value);
                setRemoveKey(false);
              }}
              placeholder={
                value?.apiKeyConfigured
                  ? "Leave blank to keep the existing key"
                  : "Optional"
              }
            />
            <button
              type="button"
              className="models-icon-button"
              disabled={busy}
              aria-label={showKey ? "Hide API key" : "Show API key"}
              aria-pressed={showKey}
              onClick={() => setShowKey((value) => !value)}
            >
              {showKey ? (
                <EyeOff size={16} aria-hidden />
              ) : (
                <Eye size={16} aria-hidden />
              )}
            </button>
          </div>
        </label>
      </div>
      {value?.apiKeyConfigured ? (
        <label className="models-checkbox">
          <input
            type="checkbox"
            checked={removeKey}
            disabled={busy || Boolean(key)}
            onChange={(event) => setRemoveKey(event.target.checked)}
          />
          Remove API key
        </label>
      ) : null}
      {error ? (
        <p className="settings__error" role="alert" tabIndex={-1}>
          {error}
        </p>
      ) : null}
      <div className="models-actions">
        <button
          className="button button--primary"
          disabled={busy || !id.trim()}
          type="submit"
        >
          Save provider
        </button>
        <button
          className="button"
          type="button"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ModelForm({
  provider,
  value,
  onSave,
  onCancel,
  busy,
  hasInheritedApi,
  error,
}: {
  provider: string;
  value: ModelDeclaration | null;
  onSave: (edit: ModelConfigEdit) => Promise<boolean>;
  onCancel: () => void;
  busy: boolean;
  hasInheritedApi: boolean;
  error?: string | null;
}) {
  const [id, setId] = useState(value?.id ?? "");
  const [name, setName] = useState(value?.name ?? "");
  const [api, setApi] = useState(value?.api ?? "");
  const [baseUrl, setBaseUrl] = useState(value?.baseUrl ?? "");
  const [contextWindow, setContextWindow] = useState(
    String(value?.contextWindow ?? ""),
  );
  const [maxTokens, setMaxTokens] = useState(String(value?.maxTokens ?? ""));
  const [reasoning, setReasoning] = useState(value?.reasoning ?? false);
  const [input, setInput] = useState(value?.input ?? ["text"]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const values: Extract<ModelConfigEdit, { kind: "model" }>["values"] = {
      id: id === value?.id ? id : id.trim(),
    };
    for (const [field, next] of Object.entries({ name, api, baseUrl })) {
      if (next !== (value?.[field as "name" | "api" | "baseUrl"] ?? ""))
        (values as Record<string, unknown>)[field] = next.trim() || null;
    }
    if (contextWindow !== String(value?.contextWindow ?? ""))
      values.contextWindow = contextWindow ? Number(contextWindow) : null;
    if (maxTokens !== String(value?.maxTokens ?? ""))
      values.maxTokens = maxTokens ? Number(maxTokens) : null;
    if (!value || reasoning !== (value.reasoning ?? false))
      values.reasoning = reasoning;
    if (!value || input.join("\0") !== (value.input ?? ["text"]).join("\0"))
      values.input = input;
    await onSave({
      kind: "model",
      provider,
      ...(value ? { originalId: value.id, originalType: value.type } : {}),
      values,
    });
  };
  return (
    <form className="models-form" onSubmit={(event) => void submit(event)}>
      <h4>
        {value ? "Edit model" : "Add model"} · {provider}
      </h4>
      <div className="models-form__grid">
        <label>
          Model ID
          <input
            required
            value={id}
            disabled={busy}
            onChange={(event) => setId(event.target.value)}
            autoFocus
            placeholder="model-id"
          />
        </label>
        <label>
          Display name
          <input
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            placeholder="Optional"
          />
        </label>
        {!hasInheritedApi ? (
          <label>
            API type
            <input
              required
              value={api}
              disabled={busy}
              onChange={(event) => setApi(event.target.value)}
              placeholder="e.g. openai-completions"
            />
          </label>
        ) : null}
      </div>
      <fieldset className="models-capabilities">
        <legend>Capabilities</legend>
        <div className="models-actions">
          <label className="models-checkbox">
            <input
              type="checkbox"
              checked={reasoning}
              disabled={busy}
              onChange={(event) => setReasoning(event.target.checked)}
            />
            Thinking supported
          </label>
          {(["text", "image"] as const).map((type) => (
            <label className="models-checkbox" key={type}>
              <input
                type="checkbox"
                checked={input.includes(type)}
                disabled={busy}
                onChange={(event) =>
                  setInput((current) =>
                    event.target.checked
                      ? [...current, type]
                      : current.filter((item) => item !== type),
                  )
                }
              />
              {type === "text" ? "Text" : "Image"} input
            </label>
          ))}
        </div>
      </fieldset>
      <div className="models-form__grid">
        <label>
          Context window
          <input
            type="number"
            step="any"
            value={contextWindow}
            disabled={busy}
            onChange={(event) => setContextWindow(event.target.value)}
            placeholder="Pi default"
          />
        </label>
        <label>
          Maximum output tokens
          <input
            type="number"
            step="any"
            value={maxTokens}
            disabled={busy}
            onChange={(event) => setMaxTokens(event.target.value)}
            placeholder="Pi default"
          />
        </label>
      </div>
      <details
        className="models-form__optional"
        open={
          Boolean((hasInheritedApi && value?.api) || value?.baseUrl) ||
          undefined
        }
      >
        <summary>Connection overrides</summary>
        <div className="models-form__grid">
          {hasInheritedApi ? (
            <label>
              API override
              <input
                value={api}
                disabled={busy}
                onChange={(event) => setApi(event.target.value)}
                placeholder="Use default"
              />
            </label>
          ) : null}
          <label>
            Base URL override
            <input
              value={baseUrl}
              disabled={busy}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="Use provider URL"
            />
          </label>
        </div>
      </details>
      {error ? (
        <p className="settings__error" role="alert" tabIndex={-1}>
          {error}
        </p>
      ) : null}
      <div className="models-actions">
        <button
          className="button button--primary"
          disabled={busy || !id.trim()}
          type="submit"
        >
          Save model
        </button>
        <button
          className="button"
          type="button"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
