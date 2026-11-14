import { useState } from "react";
import type { z } from "zod";
import {
  type ConfigurationControl,
  type SecretEdit,
  secretValue,
} from "../../shared/configuration-fields";
import {
  type ModelConfigEdit,
  type ModelDeclaration,
  modelDeclarationFields,
  type ProviderDeclaration,
  providerApiKey,
  providerDeclarationFields,
} from "../../shared/model-settings";
import {
  ConfigurationForm,
  ConfigurationInput,
  ProtectedConfigurationInput,
} from "./ConfigurationForm";
import { DetailSummary } from "./DetailSummary";

type FormProps = {
  onSave: (edit: ModelConfigEdit) => void;
  onCancel: () => void;
  busy: boolean;
  error?: string | null;
};

function useDeclarationFields<
  Fields extends Record<
    string,
    { control: ConfigurationControl; schema: z.ZodType }
  >,
>(
  fields: Fields,
  declaration: Partial<Record<keyof Fields, string | number>> | null,
  disabled: boolean,
) {
  type Field = keyof Fields & string;
  const [initial] = useState(declaration);
  const [draft, setDraft] = useState<Partial<Record<Field, string>>>({});
  return {
    bind: (field: Field) => ({
      ...fields[field].control,
      disabled,
      value: draft[field] ?? declaration?.[field] ?? "",
      onChange: ({ currentTarget }: React.ChangeEvent<HTMLInputElement>) =>
        setDraft((current) => ({ ...current, [field]: currentTarget.value })),
    }),
    patch: () =>
      Object.fromEntries(
        (Object.keys(draft) as Field[]).flatMap((field) => {
          const value = draft[field]!;
          if (value === String(initial?.[field] ?? "")) return [];
          return [
            [
              field,
              value.trim()
                ? fields[field].control.type === "number"
                  ? Number(value)
                  : value.trim()
                : null,
            ],
          ];
        }),
      ) as { [Key in Field]?: z.infer<Fields[Key]["schema"]> },
  };
}
export function ProviderForm({
  value,
  onSave,
  onCancel,
  busy,
  nativeApiProviders,
  error,
}: FormProps & {
  value: ProviderDeclaration | null;
  nativeApiProviders: string[];
}) {
  const [id, setId] = useState(value?.id ?? "");
  const fields = useDeclarationFields(providerDeclarationFields, value, busy);
  const [key, setKey] = useState<SecretEdit>({ kind: "keep" });
  const hasNativeApi = nativeApiProviders.includes(value?.id ?? id.trim());
  return (
    <ConfigurationForm
      busy={busy}
      error={error}
      saveDisabled={!id.trim()}
      onSave={() =>
        void onSave({
          kind: "provider",
          id: value?.id ?? id.trim(),
          values: {
            ...fields.patch(),
            ...(key.kind !== "keep" ? { apiKey: secretValue(key) } : {}),
          },
        })
      }
      onCancel={onCancel}
    >
      <div className="models-form__grid">
        <ConfigurationInput
          label="Provider ID"
          required
          value={id}
          disabled={Boolean(value) || busy}
          onChange={(event) => setId(event.target.value)}
          placeholder="my-provider"
          autoFocus={!value}
        />
        <ConfigurationInput
          {...fields.bind("baseUrl")}
          autoFocus={Boolean(value)}
        />
        <ConfigurationInput
          {...fields.bind("api")}
          placeholder={
            hasNativeApi ? "Use default" : "Set here or on the model"
          }
        />
        <ProtectedConfigurationInput
          control={{ ...providerApiKey, wide: true }}
          value={secretValue(key)}
          stored={value?.apiKeyConfigured}
          busy={busy}
          showValue
          onChange={(edit) => setKey(edit as SecretEdit)}
        />
      </div>
    </ConfigurationForm>
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
}: FormProps & {
  provider: string;
  value: ModelDeclaration | null;
  hasInheritedApi: boolean;
}) {
  const [id, setId] = useState(value?.id ?? "");
  const fields = useDeclarationFields(modelDeclarationFields, value, busy);
  const [reasoning, setReasoning] = useState(value?.reasoning ?? false);
  const initialInput = value?.input ?? ["text"];
  const [input, setInput] = useState(initialInput);
  return (
    <ConfigurationForm
      busy={busy}
      error={error}
      saveDisabled={!id.trim()}
      onSave={() =>
        void onSave({
          kind: "model",
          provider,
          ...(value ? { originalId: value.id, originalType: value.type } : {}),
          values: {
            id: id === value?.id ? id : id.trim(),
            ...fields.patch(),
            ...(!value || reasoning !== (value.reasoning ?? false)
              ? { reasoning }
              : {}),
            ...(!value || input.join("\0") !== initialInput.join("\0")
              ? { input }
              : {}),
          },
        })
      }
      onCancel={onCancel}
    >
      <div className="models-form__grid">
        <ConfigurationInput
          label="Model ID"
          required
          value={id}
          disabled={busy}
          onChange={(event) => setId(event.target.value)}
          autoFocus
          placeholder="model-id"
        />
        <ConfigurationInput {...fields.bind("name")} />
        {!hasInheritedApi && (
          <ConfigurationInput
            {...fields.bind("api")}
            required
            placeholder="e.g. openai-completions"
          />
        )}
      </div>
      <fieldset className="models-capabilities">
        <legend>Capabilities</legend>
        <div className="models-actions">
          <label className="models-checkbox">
            <input
              type="checkbox"
              className="choice-input"
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
                className="choice-input"
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
        <ConfigurationInput {...fields.bind("contextWindow")} />
        <ConfigurationInput {...fields.bind("maxTokens")} />
      </div>
      <details
        className="models-form__optional"
        open={
          Boolean((hasInheritedApi && value?.api) || value?.baseUrl) ||
          undefined
        }
      >
        <DetailSummary>Connection overrides</DetailSummary>
        <div className="models-form__grid">
          {hasInheritedApi && (
            <ConfigurationInput
              {...fields.bind("api")}
              label="API override"
              placeholder="Use default"
            />
          )}
          <ConfigurationInput
            {...fields.bind("baseUrl")}
            label="Base URL override"
            placeholder="Use provider URL"
          />
        </div>
      </details>
    </ConfigurationForm>
  );
}
