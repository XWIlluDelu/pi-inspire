import {
  ArrowDown,
  ArrowUp,
  Cpu,
  KeyRound,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
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
import { shallowEqual, store, useAppState } from "../store";
import { useConfigurationDocument } from "../use-configuration-document";
import {
  ConfigurationEditor,
  ConfigurationForm,
  ConfigurationInput,
  ConfigurationDetail,
  ConfigurationRefresh,
  ConfigurationRemoval,
} from "./ConfigurationForm";
import { DetailSummary } from "./DetailSummary";
import { ModelForm, ProviderForm } from "./ModelDeclarationForms";
import { ModelList } from "./ModelList";
import { NativeSelect } from "./NativeSelect";
import { ProviderAuthentication } from "./ProviderAuthentication";
import { SettingField } from "./SettingsControls";
import { SettingsSection } from "./SettingsSection";

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
  destination,
  active = true,
}: {
  destination?: ModelSettingsDestination;
  active?: boolean;
}) {
  const state = useAppState(
    (source) => ({
      sessionId: source.sessionId,
      cwd: source.cwd,
      transport: source.transportGeneration,
    }),
    shallowEqual,
  );
  const owner = useMemo<ModelSettingsOwner>(
    () =>
      destination?.owner ??
      (state.sessionId
        ? { sessionId: state.sessionId }
        : state.cwd
          ? { cwd: state.cwd }
          : {}),
    [destination?.owner, state.sessionId, state.cwd],
  );
  const settingsOwner = JSON.stringify([
    owner.sessionId,
    owner.cwd,
    state.transport,
  ]);
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
  const defaultThinkingRef = useRef<HTMLSelectElement>(null);
  const addModelRef = useRef<HTMLButtonElement>(null);
  const [selectedModelKey, setSelectedModelKey] = useState<string>();
  const providerGeneration = useRef(0);
  useLayoutEffect(() => {
    setSelectedModelKey(undefined);
    setProviders([]);
    setAuthError(null);
    setProvidersLoaded(false);
    return () => {
      providerGeneration.current++;
    };
  }, [settingsOwner]);
  const openEditor = (next: DeclarationEditor, opener: HTMLElement) =>
    configuration.open(next, opener, true);
  const load = useCallback(
    () => readSettings(() => store.readModelSettings(owner, true)),
    [readSettings, owner],
  );
  const refreshProviders = useCallback(async () => {
    if (!alive.current) return;
    const current = ++providerGeneration.current;
    const owns = () => alive.current && providerGeneration.current === current;
    setProvidersLoading(true);
    try {
      const auth = await store.providerAuth(owner, { operation: "providers" });
      if (owns()) {
        setProviders(auth as ProviderLoginOption[]);
        setProvidersLoaded(true);
        setAuthError(null);
      }
    } catch (error) {
      if (owns())
        setAuthError(error instanceof Error ? error.message : unavailable);
    } finally {
      if (owns()) setProvidersLoading(false);
    }
  }, [owner, alive]);
  const refreshCredentials = async () => {
    await Promise.all([refreshProviders(), load()]);
  };
  useEffect(() => {
    void load();
    void refreshProviders();
  }, [load, refreshProviders]);
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
        onSaved: (next) => {
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
            if (
              next.snapshot?.models.some(
                (model) =>
                  model.provider === edit.provider &&
                  model.id === edit.values.id,
              )
            )
              setSelectedModelKey(
                modelIdentityKey({
                  provider: edit.provider,
                  id: edit.values.id,
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
  const knownModels = useMemo(
    () =>
      new Map(
        [
          ...(snapshot?.providers.flatMap((provider) =>
            provider.models
              .filter((model) => !model.type || model.type === "chat")
              .map((model) => ({ ...model, provider: provider.id })),
          ) ?? []),
          ...(snapshot?.models ?? []),
        ].map((model) => [modelIdentityKey(model), model]),
      ),
    [snapshot],
  );
  const savedModel: ModelOption | null = snapshot?.saved.defaultModel
    ? (knownModels.get(modelIdentityKey(snapshot.saved.defaultModel)) ??
      snapshot.saved.defaultModel)
    : null;
  const savedKey = savedModel && modelIdentityKey(savedModel);
  const savedAvailable = snapshot?.models.some(
    (model) => modelIdentityKey(model) === savedKey,
  );
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
  const inspectedModel =
    snapshot?.models.find(
      (model) => modelIdentityKey(model) === (selectedModelKey ?? savedKey),
    ) ?? null;
  const declaredModel =
    inspectedModel &&
    snapshot?.providers
      .find((provider) => provider.id === inspectedModel.provider)
      ?.models.find(
        (entry) =>
          entry.id === inspectedModel.id &&
          (!entry.type || entry.type === "chat"),
      );
  const commonRules = inspectedModel
    ? (snapshot?.savedCommonEntries.flatMap(({ pattern, models }) =>
        models.some(
          ({ id, provider }) =>
            id === inspectedModel.id && provider === inspectedModel.provider,
        )
          ? [pattern]
          : [],
      ) ?? [])
    : [];
  const identity = inspectedModel
    ? `${inspectedModel.provider}/${inspectedModel.id}`
    : "";
  const directCommon = commonRules.filter(
    (entry) =>
      entry === identity ||
      THINKING_LEVELS.some((level) => entry === `${identity}:${level}`),
  );
  const commonPattern = commonRules.find(
    (entry) => !directCommon.includes(entry),
  );

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
  const declarations =
    snapshot?.providers.flatMap((provider) => [
      { key: declarationKey(provider.id), provider, model: null },
      ...provider.models.map((model) => ({
        key: declarationKey(provider.id, model),
        provider,
        model,
      })),
    ]) ?? [];
  const declaration = declarations.find(
    ({ key }) => key === selectedDeclaration,
  );
  const provider = declaration?.provider;
  const declared = declaration?.model;
  const providerCount = snapshot?.providers.length ?? 0;
  const modelCount = declarations.length - providerCount;
  const declarationIdentity =
    provider && declarationLabel(provider.id, declared);
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
        {providerCount} {providerCount === 1 ? "provider" : "providers"} ·{" "}
        {modelCount} {modelCount === 1 ? "model" : "models"}
      </DetailSummary>
      {declarations.length > 0 && (
        <>
          <NativeSelect
            className="native-select--field configuration-selection"
            label="Custom declaration"
            value={declaration?.key ?? ""}
            display={declaration ? undefined : "Choose custom declaration"}
            options={declarations.map(({ key, provider, model }) => ({
              value: key,
              label: declarationLabel(provider.id, model),
            }))}
            disabled={busy}
            onChange={(key) => {
              if (removing) configuration.dismiss();
              selectDeclaration(key);
            }}
          />
          {provider && declarationIdentity && (
            <ConfigurationDetail
              label={
                declared
                  ? `declared model ${declarationIdentity}`
                  : `provider ${provider.id}`
              }
              disabled={busy || configurationUnavailable}
              edit={(event) =>
                openEditor(
                  declared
                    ? { kind: "model", provider: provider.id, value: declared }
                    : { kind: "provider", value: provider },
                  event.currentTarget,
                )
              }
              remove={(event) =>
                configuration.open(
                  declared
                    ? {
                        kind: "remove-model",
                        provider: provider.id,
                        id: declared.id,
                        type: declared.type,
                      }
                    : { kind: "remove-provider", id: provider.id },
                  event.currentTarget,
                )
              }
              extra={
                !declared && (
                  <button
                    type="button"
                    className="button"
                    aria-label={`Add model to ${provider.id}`}
                    ref={addModelRef}
                    disabled={busy || configurationUnavailable}
                    onClick={(event) =>
                      openEditor(
                        {
                          kind: "model",
                          provider: provider.id,
                          value: null,
                        },
                        event.currentTarget,
                      )
                    }
                  >
                    <Plus size={13} aria-hidden /> Add model
                  </button>
                )
              }
            >
              <div>
                <strong>{declared?.name || declared?.id || provider.id}</strong>
                <br />
                <code>
                  {declared
                    ? declarationIdentity
                    : [provider.baseUrl, provider.api]
                        .filter(Boolean)
                        .join(" · ")}
                </code>
              </div>
            </ConfigurationDetail>
          )}
          {removing && (
            <ConfigurationRemoval
              busy={busy}
              blocked={configurationUnavailable}
              onRemove={() => void edit(removing)}
              onCancel={configuration.dismiss}
            >
              Remove the{" "}
              {removing.kind === "remove-provider"
                ? `provider ${removing.id}`
                : `model ${declarationLabel(removing.provider, removing)}`}{" "}
              declaration?
            </ConfigurationRemoval>
          )}
        </>
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
            {visibleError ? (
              <p className="settings__error" role="alert">
                {visibleError}
              </p>
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
                    value={inspectedModel}
                    onSelect={(model) =>
                      setSelectedModelKey(modelIdentityKey(model))
                    }
                    searchLabel="Search available models"
                    placeholder="Search models"
                    searchAction={
                      <ConfigurationRefresh
                        label="Refresh available models"
                        busy={busy}
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
                  />
                  {inspectedModel && (
                    <div
                      className="models-detail"
                      role="group"
                      aria-label="Selected model"
                    >
                      <div>
                        <strong>
                          {inspectedModel.name ?? inspectedModel.id}
                        </strong>
                        <br />
                        <code>
                          {inspectedModel.provider}/{inspectedModel.id}
                        </code>
                      </div>
                      <div className="models-actions">
                        {declaredModel && (
                          <button
                            type="button"
                            className="button button--quiet"
                            disabled={busy || configurationUnavailable}
                            aria-label={`Edit model ${inspectedModel.provider}/${inspectedModel.id}`}
                            onClick={(event) =>
                              openEditor(
                                {
                                  kind: "model",
                                  provider: inspectedModel.provider,
                                  value: declaredModel,
                                },
                                event.currentTarget,
                              )
                            }
                          >
                            Edit
                          </button>
                        )}
                        {commonPattern ? (
                          <button
                            type="button"
                            className="button button--quiet"
                            disabled={busy || preferencesUnavailable}
                            aria-label={`Edit common pattern for ${inspectedModel.name ?? inspectedModel.id}`}
                            onClick={(event) =>
                              editCommon(commonPattern, event.currentTarget)
                            }
                          >
                            Edit common rule
                          </button>
                        ) : (
                          <label className="models-choice">
                            <input
                              type="checkbox"
                              className="choice-input"
                              aria-label={`Common: ${inspectedModel.name ?? inspectedModel.id}`}
                              disabled={busy || preferencesUnavailable}
                              checked={directCommon.length > 0}
                              onChange={() =>
                                void save({
                                  enabledModels: directCommon.length
                                    ? snapshot.saved.enabledModels.filter(
                                        (entry) =>
                                          !directCommon.includes(entry),
                                      )
                                    : [
                                        ...snapshot.saved.enabledModels,
                                        `${inspectedModel.provider}/${inspectedModel.id}`,
                                      ],
                                })
                              }
                            />{" "}
                            Common
                          </label>
                        )}
                        <button
                          type="button"
                          className="button button--quiet"
                          disabled={
                            busy ||
                            preferencesUnavailable ||
                            savedKey === modelIdentityKey(inspectedModel)
                          }
                          onClick={() =>
                            void save({
                              defaultModel: {
                                provider: inspectedModel.provider,
                                id: inspectedModel.id,
                              },
                            })
                          }
                        >
                          Set as default
                        </button>
                      </div>
                    </div>
                  )}
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
                                ? `This project uses ${knownModels.get(modelIdentityKey(projectModel))?.name ?? projectModel.id}.`
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
                            {savedModel.name ?? savedModel.id}
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
                        <button
                          type="button"
                          className="models-icon-button"
                          aria-label="Clear default model"
                          title="Clear default model"
                          disabled={busy || preferencesUnavailable}
                          onClick={() => void save({ defaultModel: null })}
                        >
                          <X size={14} aria-hidden />
                        </button>
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
                    <NativeSelect
                      ref={defaultThinkingRef}
                      label="Default thinking"
                      className="native-select--field"
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
                                <button
                                  type="button"
                                  className="models-icon-button"
                                  disabled={busy}
                                  aria-label={`Edit common entry ${value}`}
                                  onClick={(event) =>
                                    editCommon(value, event.currentTarget)
                                  }
                                >
                                  <Pencil size={13} />
                                </button>
                                <button
                                  type="button"
                                  className="models-icon-button"
                                  disabled={busy || index === 0}
                                  aria-label={`Move ${value} up`}
                                  onClick={() => move(index, -1)}
                                >
                                  <ArrowUp size={13} />
                                </button>
                                <button
                                  type="button"
                                  className="models-icon-button"
                                  disabled={
                                    busy ||
                                    index ===
                                      snapshot.saved.enabledModels.length - 1
                                  }
                                  aria-label={`Move ${value} down`}
                                  onClick={() => move(index, 1)}
                                >
                                  <ArrowDown size={13} />
                                </button>
                                <button
                                  type="button"
                                  className="models-icon-button"
                                  disabled={busy}
                                  aria-label={`Remove ${value} from common models`}
                                  onClick={() =>
                                    void save({
                                      enabledModels:
                                        snapshot.saved.enabledModels.filter(
                                          (_, selected) => selected !== index,
                                        ),
                                    })
                                  }
                                >
                                  <Trash2 size={13} />
                                </button>
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
            ) : readFailed ? (
              <button
                type="button"
                className="button button--quiet"
                onClick={() => void load()}
              >
                Retry loading models
              </button>
            ) : (
              <p className="settings__field-help" role="status">
                Loading models…
              </p>
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
