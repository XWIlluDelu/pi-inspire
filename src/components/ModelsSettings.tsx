import {
  ArrowDown,
  ArrowUp,
  Cpu,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ModelOption,
  modelIdentityKey,
  THINKING_LEVELS,
} from "../../shared/contracts";
import type {
  ModelConfigEdit,
  ModelDeclaration,
  ModelPreferencesPatch,
  ModelSettingsDestination,
  ModelSettingsOwner,
  ModelSettingsSnapshot,
  ProviderDeclaration,
  ProviderLoginOption,
} from "../../shared/model-settings";
import { thinkingLevelLabel, thinkingLevelOptions } from "../model-options";
import { store, useAppState } from "../store";
import { useConfigurationDocument } from "../use-configuration-document";
import {
  ConfigurationAction,
  ConfigurationConfirmation,
  ConfigurationDetail,
  ConfigurationEditor,
  ConfigurationForm,
  ConfigurationInput,
} from "./ConfigurationForm";
import { DetailSummary } from "./DetailSummary";
import { ModelForm, ProviderForm } from "./ModelDeclarationForms";
import { ModelList } from "./ModelList";
import { Dropdown } from "./Dropdown";
import { ProviderAuthentication } from "./ProviderAuthentication";
import { SettingField } from "./SettingsControls";
import { SettingsCardMessage, SettingsSection } from "./SettingsSection";

type DeclarationEditor =
  | { kind: "provider"; value: ProviderDeclaration | null }
  | { kind: "model"; provider: string; value: ModelDeclaration | null };
type Removal = Extract<
  ModelConfigEdit,
  { kind: "remove-provider" | "remove-model" }
>;
type Selection =
  | DeclarationEditor
  | Removal
  | { kind: "common"; pattern: string; value: string };

const declarationKey = (
  provider: string,
  model?: { id: string; type?: string | null },
) =>
  JSON.stringify(
    model ? [provider, model.type ?? "chat", model.id] : [provider],
  );
function declarationLabel(
  provider: string,
  model?: { id: string; type?: string | null } | null,
) {
  if (!model) return provider;
  const type = model.type && model.type !== "chat" ? ` (${model.type})` : "";
  return `${provider}/${model.id.trimEnd()}${type}`;
}
const unavailable = "The Host could not complete this operation";
export function ModelsSettings({
  owner,
  destination,
  active,
}: {
  owner: ModelSettingsOwner;
  destination?: ModelSettingsDestination;
  active: boolean;
}) {
  const transport = useAppState((state) => state.transportGeneration);
  const settingsOwner = JSON.stringify([owner.sessionId, owner.cwd, transport]);
  const configuration = useConfigurationDocument<
    ModelSettingsSnapshot,
    Selection
  >({
    owner: settingsOwner,
    active,
    unavailable,
    fallbackFocus: '[aria-label="Search available models"]',
  });
  const {
    snapshot,
    error,
    readFailed,
    busy,
    alive,
    load: readSettings,
    write,
    edit: selection,
    selected: selectedDeclaration,
    select: selectDeclaration,
  } = configuration;
  const editingCommon = selection?.kind === "common" ? selection : null;
  const editor =
    selection?.kind === "model" || selection?.kind === "provider"
      ? selection
      : null;
  const removing =
    selection?.kind === "remove-provider" || selection?.kind === "remove-model"
      ? selection
      : null;
  const [providers, setProviders] = useState<ProviderLoginOption[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const declarationsRef = useRef<HTMLDetailsElement>(null);
  const savedEntriesRef = useRef<HTMLDetailsElement>(null);
  const addProviderRef = useRef<HTMLButtonElement>(null);
  const defaultThinkingRef = useRef<HTMLButtonElement>(null);
  const addModelRef = useRef<HTMLButtonElement>(null);
  const defaultGroupName = useId();
  const providerGeneration = useRef(0);
  const opened = useRef(false);
  useLayoutEffect(() => {
    opened.current = false;
    setProviders([]);
    setAuthError(null);
    setProvidersLoaded(false);
    return () => {
      providerGeneration.current++;
    };
  }, [settingsOwner]);
  const openEditor = (next: DeclarationEditor, opener: HTMLElement) =>
    configuration.open(next, opener, true);
  const readConfig = useCallback(
    () => store.readModelSettings(owner, true),
    [owner],
  );
  const load = useCallback(() => readSettings(readConfig), [readSettings, readConfig]);
  const refreshProviders = useCallback(async () => {
    if (!alive.current) return;
    const current = ++providerGeneration.current;
    const owns = () => alive.current && providerGeneration.current === current;
    setProvidersLoading(true);
    try {
      const auth = (await store.providerAuth(owner, { operation: "providers" })) as ProviderLoginOption[];
      if (owns()) {
        setProviders(auth);
        setProvidersLoaded(true);
        setAuthError(null);
        return auth;
      }
    } catch (error) {
      if (owns())
        setAuthError(error instanceof Error ? error.message : unavailable);
    } finally {
      if (owns()) setProvidersLoading(false);
    }
  }, [owner, alive]);
  const refreshCredentials = async () => {
    const [providers] = await Promise.all([refreshProviders(), load()]);
    return providers;
  };
  useEffect(() => {
    if (!active || opened.current) return;
    opened.current = true;
    void load();
    void refreshProviders();
  }, [active, load, refreshProviders]);
  const focusedDestination = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = `${destination?.focus ?? ""}/${destination?.query ?? ""}`;
    if (
      !active ||
      !snapshot ||
      !destination?.focus ||
      focusedDestination.current === key
    )
      return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(
          destination.focus === "credentials"
            ? "settings-section-credentials"
            : "settings-section-models",
        )
        ?.scrollIntoView({ block: "start" });
      focusedDestination.current = key;
    });
    return () => cancelAnimationFrame(frame);
  }, [active, snapshot, destination]);
  const save = (patch: ModelPreferencesPatch, fromEditor = false) => {
    if (!snapshot || readFailed) return;
    return write(
      () => store.saveModelPreferences(owner, snapshot.settingsRevision, patch),
      {
        close: fromEditor,
        readBack: readConfig,
        onSaved: () =>
          patch.defaultModel === null
            ? () => defaultThinkingRef.current
            : undefined,
        onError: fromEditor
          ? () =>
              configuration.root.current?.querySelector<HTMLElement>(
                '.models-common__editor [role="alert"]',
              ) ?? null
          : undefined,
      },
    );
  };
  const edit = async (edit: ModelConfigEdit) => {
    if (!snapshot || readFailed || snapshot.configError) return;
    const saved = await write(
      () => store.editModelConfig(owner, snapshot.configRevision, edit),
      {
        close: true,
        readBack: readConfig,
        onSaved: () => {
          if (
            edit.kind === "provider" &&
            editor?.kind === "provider" &&
            !editor.value
          ) {
            if (declarationsRef.current) declarationsRef.current.open = true;
            selectDeclaration(declarationKey(edit.id));
            return () => addModelRef.current ?? addProviderRef.current;
          }
          if (edit.kind === "model") {
            selectDeclaration(
              declarationKey(edit.provider, {
                id: edit.values.id,
                type: edit.values.type ?? edit.originalType,
              }),
            );
          }
          if (edit.kind === "remove-model") {
            selectDeclaration(declarationKey(edit.provider));
            return () => addModelRef.current ?? addProviderRef.current;
          }
          if (edit.kind === "remove-provider") {
            selectDeclaration(undefined);
            return () => addProviderRef.current;
          }
        },
        onError: () =>
          configuration.root.current?.querySelector<HTMLElement>(
            '.models-form [role="alert"], .models-browse [role="alert"]',
          ) ?? null,
      },
    );
    if (saved) await refreshProviders();
  };
  const models = useMemo(() => {
    const declarations = new Map<string, ModelDeclaration>();
    for (const { id: provider, models } of snapshot?.providers ?? [])
      for (const model of models)
        if (!model.type || model.type === "chat") {
          const key = modelIdentityKey({ provider, id: model.id });
          if (!declarations.has(key)) declarations.set(key, model);
        }
    return {
      declarations,
      available: new Map(
        snapshot?.models.map((model) => [modelIdentityKey(model), model]),
      ),
    };
  }, [snapshot?.models, snapshot?.providers]);
  const modelName = (model: ModelOption) => {
    const key = modelIdentityKey(model);
    const entry = models.available.get(key) ?? models.declarations.get(key);
    return entry?.name ?? model.id;
  };
  const savedModel = snapshot?.saved.defaultModel;
  const savedKey = savedModel && modelIdentityKey(savedModel);
  const savedAvailable = Boolean(savedKey && models.available.has(savedKey));
  const preferencesUnavailable = readFailed || Boolean(snapshot?.settingsError);
  const configurationUnavailable = readFailed || Boolean(snapshot?.configError);
  const projectModelOverride = snapshot?.projectOverrides.some(
    (field) => field === "defaultModel" || field === "defaultProvider",
  );
  const projectModel = snapshot?.effective.defaultModel;
  const modelProvider =
    editor?.kind === "model"
      ? snapshot?.providers.find((provider) => provider.id === editor.provider)
      : undefined;
  const commonSources = useMemo(() => {
    const sources = new Map<string, string[]>();
    for (const entry of snapshot?.savedCommonEntries ?? [])
      for (const model of entry.models) {
        const key = modelIdentityKey(model),
          entries = sources.get(key) ?? [];
        entries.push(entry.pattern);
        sources.set(key, entries);
      }
    return sources;
  }, [snapshot]);

  const hasInheritedApi = Boolean(
    modelProvider &&
      (modelProvider.api ||
        snapshot?.nativeApiProviders?.includes(modelProvider.id) ||
        modelProvider.models
          .slice(
            0,
            editor?.kind === "model" && editor.value
              ? Math.max(
                  0,
                  modelProvider.models.findIndex(
                    (model) =>
                      model.id === editor.value?.id &&
                      (model.type ?? "chat") === (editor.value?.type ?? "chat"),
                  ),
                )
              : modelProvider.models.length,
          )
          .some((model) => model.api)),
  );
  const visibleError =
    (!editor && !editingCommon ? error : null) ??
    snapshot?.settingsError ??
    snapshot?.configError ??
    snapshot?.projectSettingsError;
  const editCommon = (pattern: string, opener: HTMLElement) => {
    configuration.open({ kind: "common", pattern, value: pattern }, opener);
    if (savedEntriesRef.current) {
      savedEntriesRef.current.open = true;
      savedEntriesRef.current.scrollIntoView({ block: "nearest" });
    }
  };
  const commonEditorIndex = editingCommon
    ? (snapshot?.saved.enabledModels.indexOf(editingCommon.pattern) ?? -1)
    : -1;
  const commonEditor = editingCommon && (
    <ConfigurationForm
      inline
      busy={busy}
      saveDisabled={
        preferencesUnavailable ||
        commonEditorIndex < 0 ||
        !editingCommon.value.trim()
      }
      error={
        commonEditorIndex < 0
          ? "This rule changed on disk. Copy your edit or cancel."
          : error
      }
      onCancel={configuration.dismiss}
      onSave={() => {
        const value = editingCommon.value.trim();
        if (snapshot && value && commonEditorIndex >= 0)
          void save(
            {
              enabledModels: snapshot.saved.enabledModels.map(
                (pattern, index) =>
                  index === commonEditorIndex ? value : pattern,
              ),
            },
            true,
          );
      }}
    >
      <ConfigurationInput
        label="Model pattern"
        value={editingCommon.value}
        disabled={busy}
        onChange={(event) =>
          configuration.updateEdit({
            ...editingCommon,
            value: event.target.value,
          })
        }
        autoFocus
      />
    </ConfigurationForm>
  );
  const move = (index: number, direction: -1 | 1) => {
    if (!snapshot) return;
    const patterns = [...snapshot.saved.enabledModels];
    [patterns[index], patterns[index + direction]] = [
      patterns[index + direction]!,
      patterns[index]!,
    ];
    void save({ enabledModels: patterns });
  };
  const providersWithDeclarations = snapshot?.providers ?? [];
  const modelCount = providersWithDeclarations.reduce(
    (count, provider) => count + provider.models.length,
    0,
  );
  const customConfiguration = (
    <details
      className="models-advanced-providers"
      key={settingsOwner}
      ref={declarationsRef}
    >
      <DetailSummary
        className="models-advanced-providers__summary"
        aria-label="Custom provider declarations"
      >
        {providersWithDeclarations.length}{" "}
        {providersWithDeclarations.length === 1 ? "provider" : "providers"} ·{" "}
        {modelCount} {modelCount === 1 ? "model" : "models"}
      </DetailSummary>
      <div className="models-declared-providers">
        {providersWithDeclarations.map((provider) => (
          <section
            className="models-provider-config"
            key={provider.id}
            aria-label={`Custom provider ${provider.id}`}
          >
            <ConfigurationDetail
              label={`provider ${provider.id}`}
              name={provider.id}
              description={
                <code>
                  {[provider.baseUrl, provider.api].filter(Boolean).join(" · ")}
                </code>
              }
              disabled={busy || configurationUnavailable}
              edit={(event) =>
                openEditor(
                  { kind: "provider", value: provider },
                  event.currentTarget,
                )
              }
              remove={(event) =>
                configuration.open(
                  { kind: "remove-provider", id: provider.id },
                  event.currentTarget,
                )
              }
            >
              <button
                type="button"
                className="button"
                aria-label={`Add model to ${provider.id}`}
                ref={
                  selectedDeclaration === declarationKey(provider.id)
                    ? addModelRef
                    : undefined
                }
                disabled={busy || configurationUnavailable}
                onClick={(event) =>
                  openEditor(
                    { kind: "model", provider: provider.id, value: null },
                    event.currentTarget,
                  )
                }
              >
                <Plus size={13} aria-hidden /> Add model
              </button>
            </ConfigurationDetail>
            {provider.models.length > 0 && (
              <details className="models-provider-models">
                <DetailSummary>Models ({provider.models.length})</DetailSummary>
                <div className="models-declared-models">
                  {provider.models.map((model) => {
                    const id = declarationLabel(provider.id, model);
                    return (
                      <ConfigurationDetail
                        key={declarationKey(provider.id, model)}
                        label={`declared model ${id}`}
                        name={model.name || model.id}
                        description={<code>{id}</code>}
                        disabled={busy || configurationUnavailable}
                        edit={(event) =>
                          openEditor(
                            {
                              kind: "model",
                              provider: provider.id,
                              value: model,
                            },
                            event.currentTarget,
                          )
                        }
                        remove={(event) =>
                          configuration.open(
                            {
                              kind: "remove-model",
                              provider: provider.id,
                              id: model.id,
                              type: model.type,
                            },
                            event.currentTarget,
                          )
                        }
                      />
                    );
                  })}
                </div>
              </details>
            )}
          </section>
        ))}
      </div>
      {removing && (
        <ConfigurationConfirmation
          confirmLabel="Remove configuration"
          cancelDisabled={busy}
          confirmDisabled={busy || configurationUnavailable}
          onConfirm={() => void edit(removing)}
          onCancel={configuration.dismiss}
        >
          Remove the{" "}
          {removing.kind === "remove-provider"
            ? `provider ${removing.id}`
            : `model ${declarationLabel(removing.provider, removing)}`}{" "}
          declaration?
        </ConfigurationConfirmation>
      )}
    </details>
  );
  return (
    <div className="models-settings-layout" ref={configuration.root}>
      {editor && (
        <ConfigurationEditor
          title={`${editor.value ? "Edit" : "Add"} ${editor.kind}`}
          identity={
            editor.kind === "model"
              ? declarationLabel(editor.provider, editor.value)
              : editor.value?.id
          }
          backLabel="Back to models"
          busy={busy}
          onClose={configuration.dismiss}
          refresh={{
            label: "Refresh available models",
            run: () => void load(),
          }}
        >
          {editor.kind === "provider" ? (
            <ProviderForm
              value={editor.value}
              busy={busy || configurationUnavailable}
              nativeApiProviders={snapshot?.nativeApiProviders ?? []}
              error={error}
              onCancel={configuration.dismiss}
              onSave={edit}
            />
          ) : (
            <ModelForm
              provider={editor.provider}
              value={editor.value}
              busy={busy || configurationUnavailable}
              hasInheritedApi={hasInheritedApi}
              error={error}
              onCancel={configuration.dismiss}
              onSave={edit}
            />
          )}
        </ConfigurationEditor>
      )}
      <div className="models-browse" hidden={!configuration.browsing}>
        <SettingsSection id="models" icon={<Cpu size={14} />} title="Models">
          <div className="models-settings">
            {snapshot && visibleError ? (
              <SettingsCardMessage error>{visibleError}</SettingsCardMessage>
            ) : null}
            {snapshot ? (
              <>
                <div className="models-available">
                  <ModelList
                    key={JSON.stringify([
                      settingsOwner,
                      destination?.focus === "common"
                        ? destination.query
                        : undefined,
                    ])}
                    initialQuery={
                      destination?.focus === "common"
                        ? destination.query
                        : undefined
                    }
                    models={snapshot.models}
                    status={snapshot.modelsWarning}
                    value={savedModel ?? null}
                    searchLabel="Search available models"
                    placeholder="Search models"
                    searchAction={
                      <ConfigurationAction
                        label="Refresh available models"
                        icon={RefreshCw}
                        disabled={busy}
                        onClick={() => void load()}
                      />
                    }
                    emptyAction={
                      <button
                        type="button"
                        className="models-text-button"
                        onClick={() => {
                          document
                            .getElementById("settings-section-credentials")
                            ?.scrollIntoView({ block: "start" });
                        }}
                      >
                        Connect a provider
                      </button>
                    }
                    renderNameAction={(model, active) => {
                      const declared = models.declarations.get(
                        modelIdentityKey(model),
                      );
                      return declared ? (
                        <button
                          type="button"
                          className="models-icon-button models-name-action"
                          tabIndex={active ? 0 : -1}
                          disabled={busy || configurationUnavailable}
                          aria-label={`Edit model ${model.provider}/${model.id}`}
                          onClick={(event) =>
                            openEditor(
                              {
                                kind: "model",
                                provider: model.provider,
                                value: declared,
                              },
                              event.currentTarget,
                            )
                          }
                        >
                          <Pencil size={13} aria-hidden />
                        </button>
                      ) : null;
                    }}
                    renderActions={(model, active) => {
                      const identity = `${model.provider}/${model.id}`;
                      const sources =
                        commonSources.get(modelIdentityKey(model)) ?? [];
                      const exact = sources.filter(
                        (entry) =>
                          entry === identity ||
                          THINKING_LEVELS.some(
                            (level) => entry === `${identity}:${level}`,
                          ),
                      );
                      const patterns = sources.filter(
                        (entry) => !exact.includes(entry),
                      );
                      const selected =
                        savedModel &&
                        modelIdentityKey(savedModel) ===
                          modelIdentityKey(model);
                      return (
                        <>
                          {patterns.length ? (
                            <button
                              type="button"
                              className="models-rule-action"
                              data-model-action="common"
                              tabIndex={active ? 0 : -1}
                              disabled={busy || preferencesUnavailable}
                              title={`Included by ${patterns.join(", ")} — edit rule`}
                              aria-label={`Edit common pattern for ${model.name ?? model.id}`}
                              onClick={(event) =>
                                editCommon(patterns[0]!, event.currentTarget)
                              }
                            >
                              <Pencil size={12} aria-hidden />
                              Via rule
                            </button>
                          ) : (
                            <label className="models-choice">
                              <input
                                type="checkbox"
                                className="choice-input"
                                data-model-action="common"
                                tabIndex={active ? 0 : -1}
                                disabled={busy || preferencesUnavailable}
                                checked={Boolean(exact.length)}
                                aria-label={`Common: ${model.name ?? model.id}`}
                                onChange={() =>
                                  void save({
                                    enabledModels: exact.length
                                      ? snapshot.saved.enabledModels.filter(
                                          (entry) => !exact.includes(entry),
                                        )
                                      : [
                                          ...snapshot.saved.enabledModels,
                                          identity,
                                        ],
                                  })
                                }
                              />
                              <span>Common</span>
                            </label>
                          )}
                          <label className="models-choice">
                            <input
                              type="radio"
                              className="choice-input"
                              name={defaultGroupName}
                              data-model-action="default"
                              tabIndex={active ? 0 : -1}
                              disabled={busy || preferencesUnavailable}
                              checked={Boolean(selected)}
                              aria-label={`Default: ${model.name ?? model.id}`}
                              onChange={() =>
                                void save({
                                  defaultModel: {
                                    provider: model.provider,
                                    id: model.id,
                                  },
                                })
                              }
                            />
                            <span>Default</span>
                          </label>
                        </>
                      );
                    }}
                  />
                </div>

                <div className="models-results">
                  <SettingField
                    label="Default model"
                    layout={savedModel ? "adaptive" : "inline"}
                    description={
                      preferencesUnavailable
                        ? undefined
                        : savedModel
                          ? [
                              !savedAvailable
                                ? "Saved, but not in the current model list."
                                : null,
                              projectModelOverride && projectModel
                                ? `This project uses ${modelName(projectModel)}.`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" ") || undefined
                          : "Choose a model above to set it as the default."
                    }
                  >
                    {savedModel ? (
                      <div
                        className="models-default-value"
                        title={`${savedModel.provider}/${savedModel.id}${
                          !savedAvailable ? " · Not currently available" : ""
                        }`}
                      >
                        <span className="models-default-value__identity">
                          <span className="models-default-value__name">
                            {modelName(savedModel)}
                          </span>
                          <span className="models-default-value__id">
                            {savedModel.provider}/{savedModel.id}
                          </span>
                        </span>
                        {!savedAvailable ? (
                          <span className="models-default-value__warning">
                            · Not available now
                          </span>
                        ) : null}
                        <ConfigurationAction
                          label="Clear default model"
                          icon={X}
                          disabled={busy || preferencesUnavailable}
                          onClick={() => void save({ defaultModel: null })}
                        />
                      </div>
                    ) : (
                      <span className="models-default-result models-default-result--muted">
                        {preferencesUnavailable ? "Unavailable" : "Not set"}
                      </span>
                    )}
                  </SettingField>

                  <SettingField
                    label="Default thinking"
                    description={
                      snapshot.projectOverrides.includes("defaultThinkingLevel")
                        ? `This project uses ${thinkingLevelLabel(snapshot.effective.defaultThinkingLevel ?? "Model default")}.`
                        : undefined
                    }
                  >
                    <Dropdown
                      ref={defaultThinkingRef}
                      label="Default thinking"
                      className="dropdown-trigger--field"
                      value={snapshot.saved.defaultThinkingLevel ?? "unset"}
                      display={
                        preferencesUnavailable ? "Unavailable" : undefined
                      }
                      disabled={busy || preferencesUnavailable}
                      options={[
                        {
                          value: "unset",
                          label: "Model default",
                          description: "Use each model's own setting.",
                        },
                        ...thinkingLevelOptions(THINKING_LEVELS),
                      ]}
                      onChange={(value) =>
                        void save({
                          defaultThinkingLevel:
                            value === "unset"
                              ? null
                              : (value as (typeof THINKING_LEVELS)[number]),
                        })
                      }
                    />
                  </SettingField>
                </div>

                {snapshot.saved.enabledModels.length || editingCommon ? (
                  <details
                    ref={savedEntriesRef}
                    className="models-saved-entries"
                  >
                    <DetailSummary>
                      Common order and rules (
                      {snapshot.saved.enabledModels.length})
                    </DetailSummary>
                    <p
                      className="settings__field-help"
                      style={{ paddingTop: "var(--space-2)" }}
                    >
                      Order used when cycling models. Rules can match several
                      models.
                    </p>
                    {snapshot.projectOverrides.includes("enabledModels") ? (
                      <p
                        className="settings__field-help"
                        style={{ paddingTop: "var(--space-1)" }}
                      >
                        This project has its own common models.
                      </p>
                    ) : null}
                    <ol className="models-common">
                      {snapshot.saved.enabledModels.map((value, index) => (
                        <li key={`${index}/${value}`}>
                          {commonEditorIndex === index ? (
                            commonEditor
                          ) : (
                            <>
                              <span className="models-common__copy">
                                <span>{value}</span>
                                {!snapshot.savedCommonEntries[index]?.models
                                  .length ? (
                                  <small>Not currently available</small>
                                ) : null}
                              </span>
                              <div className="models-actions">
                                <ConfigurationAction
                                  label={`Edit common entry ${value}`}
                                  icon={Pencil}
                                  disabled={busy}
                                  onClick={(event) =>
                                    editCommon(value, event.currentTarget)
                                  }
                                />
                                <ConfigurationAction
                                  label={`Move ${value} up`}
                                  icon={ArrowUp}
                                  disabled={busy || index === 0}
                                  onClick={() => move(index, -1)}
                                />
                                <ConfigurationAction
                                  label={`Move ${value} down`}
                                  icon={ArrowDown}
                                  disabled={
                                    busy ||
                                    index ===
                                      snapshot.saved.enabledModels.length - 1
                                  }
                                  onClick={() => move(index, 1)}
                                />
                                <ConfigurationAction
                                  label={`Remove ${value} from common models`}
                                  icon={Trash2}
                                  disabled={busy}
                                  onClick={() =>
                                    void save({
                                      enabledModels:
                                        snapshot.saved.enabledModels.filter(
                                          (_, selected) => selected !== index,
                                        ),
                                    })
                                  }
                                />
                              </div>
                            </>
                          )}
                        </li>
                      ))}
                    </ol>
                    {commonEditorIndex < 0 && commonEditor}
                  </details>
                ) : null}
              </>
            ) : (
              <SettingsCardMessage
                loading={!readFailed}
                error={readFailed}
                retry={
                  readFailed
                    ? { run: () => void load(), label: "Retry loading models" }
                    : undefined
                }
              >
                {readFailed ? visibleError : "Loading models…"}
              </SettingsCardMessage>
            )}
          </div>
        </SettingsSection>

        <SettingsSection
          id="credentials"
          icon={<KeyRound size={14} />}
          title="Login & API keys"
        >
          <ProviderAuthentication
            owner={owner}
            providers={providers}
            initialQuery={
              destination?.focus === "credentials"
                ? destination.query
                : undefined
            }
            discover={destination?.focus === "credentials"}
            loadError={authError}
            loading={providersLoading}
            loaded={providersLoaded}
            onRefresh={refreshCredentials}
          />
        </SettingsSection>

        {snapshot ? (
          <SettingsSection
            id="custom-providers"
            icon={<Cpu size={14} />}
            title="Custom providers"
            headerAction={
              <button
                type="button"
                className="button"
                disabled={busy || configurationUnavailable}
                ref={addProviderRef}
                onClick={(event) =>
                  openEditor(
                    { kind: "provider", value: null },
                    event.currentTarget,
                  )
                }
              >
                <Plus size={14} aria-hidden /> Add provider
              </button>
            }
          >
            <div className="models-settings">{customConfiguration}</div>
          </SettingsSection>
        ) : null}
      </div>
    </div>
  );
}
