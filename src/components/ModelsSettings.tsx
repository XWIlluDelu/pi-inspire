import {
  ArrowDown,
  ArrowLeft,
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
  ModelSettingsSnapshot,
  ProviderDeclaration,
  ProviderLoginOption,
} from "../../shared/model-settings";
import { thinkingLevelLabel, thinkingLevelOptions } from "../model-options";
import { shallowEqual, store, useAppState } from "../store";
import { useConfigurationDocument } from "../use-configuration-document";
import { DetailSummary } from "./DetailSummary";
import { ModelForm, ProviderForm } from "./ModelDeclarationForms";
import { ModelList } from "./ModelList";
import { NativeSelect } from "./NativeSelect";
import { ProviderAuthentication } from "./ProviderAuthentication";
import { SettingField } from "./SettingsControls";
import { SettingsSection } from "./SettingsSection";

type Owner = { sessionId?: string; cwd?: string };
type FocusHandoff = {
  origin: HTMLElement | null;
  release: () => void;
};
type FocusTarget = () => HTMLElement | null;
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The Host could not complete this operation";
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
  const owner = useMemo<Owner>(
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
  const {
    snapshot,
    error,
    setError,
    readFailed,
    busy,
    alive,
    revision: generation,
    load: readSettings,
    write,
  } = useConfigurationDocument<ModelSettingsSnapshot>(
    settingsOwner,
    "The Host could not complete this operation",
  );
  const [providers, setProviders] = useState<ProviderLoginOption[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [errorTarget, setErrorTarget] = useState<"config" | "common" | null>(
    null,
  );
  const [editingCommon, setEditingCommon] = useState<{
    index: number;
    value: string;
  } | null>(null);
  const [editor, setEditor] = useState<
    | { kind: "provider"; value: ProviderDeclaration | null }
    | { kind: "model"; provider: string; value: ModelDeclaration | null }
    | null
  >(null);
  const [removing, setRemoving] = useState<Extract<
    ModelConfigEdit,
    { kind: "remove-provider" | "remove-model" }
  > | null>(null);
  const [declarationsOpen, setDeclarationsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const savedEntriesRef = useRef<HTMLDetailsElement>(null);
  const editorOpener = useRef<HTMLElement | null>(null);
  const editorTitleId = useId();
  const browseScroll = useRef(0);
  const wasEditing = useRef(false);
  const commonOpener = useRef<HTMLElement | null>(null);
  const addProviderRef = useRef<HTMLButtonElement>(null);
  const defaultThinkingRef = useRef<HTMLSelectElement>(null);
  const addModelRefs = useRef(new Map<string, HTMLButtonElement>());
  const removalOpener = useRef<HTMLElement | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState<string>();
  const handoff = useRef<FocusHandoff | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const providerGeneration = useRef(0);
  useLayoutEffect(() => {
    setEditingCommon(null);
    setEditor(null);
    setRemoving(null);
    setDeclarationsOpen(false);
    setSelectedModelKey(undefined);
    setProviders([]);
    setAuthError(null);
    setProvidersLoaded(false);
    setErrorTarget(null);
    return () => {
      handoff.current?.release();
      providerGeneration.current++;
    };
  }, [settingsOwner]);
  const captureFocus = () => {
    handoff.current?.release();
    const origin =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!rootRef.current?.contains(origin)) return null;
    const observe = (event: FocusEvent) => {
      if (event.target !== origin && event.target !== document.body) release();
    };
    const release = () => {
      document.removeEventListener("focusin", observe, true);
      if (handoff.current === pending) handoff.current = null;
    };
    const pending = {
      origin,
      release,
    };
    handoff.current = pending;
    document.addEventListener("focusin", observe, true);
    return pending;
  };
  useLayoutEffect(() => {
    const content = rootRef.current?.closest(".settings__content");
    if (active && editor && !wasEditing.current) {
      rootRef.current
        ?.querySelector(".models-form__body")
        ?.scrollTo({ top: 0, behavior: "instant" });
    }
    if (active && content && Boolean(editor) !== wasEditing.current) {
      content.scrollTo({
        top: editor ? 0 : browseScroll.current,
        behavior: "instant",
      });
    }
    wasEditing.current = Boolean(editor);
  }, [editor, active]);
  useLayoutEffect(() => {
    if (busy || !focusTarget) return;
    const pending = handoff.current;
    if (pending && active) {
      const element = focusTarget();
      const target =
        element?.isConnected && !element.matches(":disabled")
          ? element
          : rootRef.current?.querySelector<HTMLElement>(
              '[aria-label="Search available models"]',
            );
      pending.release();
      target?.focus();
    } else pending?.release();
    setFocusTarget(null);
  }, [busy, focusTarget, active]);
  const returnFocus = (target: FocusTarget) => {
    if (captureFocus()) setFocusTarget(() => target);
  };
  const openEditor = (next: typeof editor, opener: HTMLElement) => {
    editorOpener.current = opener;
    browseScroll.current =
      rootRef.current?.closest(".settings__content")?.scrollTop ?? 0;
    setError(null);
    setEditor(next);
    setRemoving(null);
  };
  const cancelEditor = () => {
    setError(null);
    setEditor(null);
    returnFocus(() => editorOpener.current);
  };
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
      if (owns()) setAuthError(messageOf(error));
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
  const mutate = async (
    operation: () => Promise<{
      snapshot?: ModelSettingsSnapshot;
      warning?: string;
    }>,
    onSaved?: (next: { snapshot?: ModelSettingsSnapshot }) => FocusTarget,
    target: "config" | "common" | null = null,
  ): Promise<boolean> => {
    if (busy) return false;
    const pending = captureFocus();
    setErrorTarget(target);
    const saving = write(operation);
    const writingVersion = generation.current;
    const next = await saving;
    if (!alive.current || generation.current !== writingVersion) return false;
    let targetAfterSave: FocusTarget = () => pending?.origin ?? null;
    if (next) {
      setErrorTarget(null);
      if (onSaved) targetAfterSave = onSaved(next);
    } else if (target) {
      targetAfterSave = () =>
        rootRef.current?.querySelector<HTMLElement>(
          target === "config"
            ? '.models-form [role="alert"]'
            : '.models-common__editor [role="alert"]',
        ) ??
        pending?.origin ??
        null;
    }
    if (pending && handoff.current === pending)
      setFocusTarget(() => targetAfterSave);
    return Boolean(next);
  };
  const save = async (patch: ModelPreferencesPatch) => {
    if (!snapshot || readFailed) return false;
    return mutate(
      () => store.saveModelPreferences(owner, snapshot.settingsRevision, patch),
      () => {
        const target =
          patch.enabledModels && editingCommon
            ? commonOpener.current
            : (handoff.current?.origin ?? null);
        if (patch.enabledModels) setEditingCommon(null);
        return () =>
          patch.defaultModel === null ? defaultThinkingRef.current : target;
      },
      editingCommon ? "common" : null,
    );
  };
  const edit = async (edit: ModelConfigEdit) => {
    if (!snapshot || readFailed || snapshot.configError) return false;
    const saved = await mutate(
      () => store.editModelConfig(owner, snapshot.configRevision, edit),
      (next) => {
        setEditor(null);
        setRemoving(null);
        if (
          edit.kind === "provider" &&
          editor?.kind === "provider" &&
          !editor.value
        ) {
          setDeclarationsOpen(true);
        }
        if (edit.kind === "model") {
          if (
            next.snapshot?.models.some(
              (model) =>
                model.provider === edit.provider && model.id === edit.values.id,
            )
          )
            setSelectedModelKey(
              modelIdentityKey({ provider: edit.provider, id: edit.values.id }),
            );
          return () => editorOpener.current;
        }
        return () =>
          (edit.kind === "provider" &&
            editor?.kind === "provider" &&
            !editor.value) ||
          edit.kind === "remove-model"
            ? (addModelRefs.current.get(
                edit.kind === "provider" ? edit.id : edit.provider,
              ) ?? addProviderRef.current)
            : edit.kind === "remove-provider"
              ? addProviderRef.current
              : editorOpener.current;
      },
      editor && (edit.kind === "provider" || edit.kind === "model")
        ? "config"
        : null,
    );
    if (saved) await refreshProviders();
    return saved;
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
  const savedModel: ModelOption | null = snapshot?.saved.defaultModel
    ? (knownModels.get(modelIdentityKey(snapshot.saved.defaultModel)) ??
      snapshot.saved.defaultModel)
    : null;
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
      (model) =>
        modelIdentityKey(model) ===
        (selectedModelKey ??
          (savedModel ? modelIdentityKey(savedModel) : null)),
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
    ? (commonSources.get(modelIdentityKey(inspectedModel)) ?? [])
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
    ((errorTarget === "config" && editor) ||
    (errorTarget === "common" && editingCommon)
      ? null
      : error) ??
    snapshot?.settingsError ??
    snapshot?.configError ??
    snapshot?.projectSettingsError;
  const editCommon = (pattern: string, opener: HTMLElement) => {
    if (!snapshot) return;
    commonOpener.current = opener;
    setEditingCommon({
      index: snapshot.saved.enabledModels.indexOf(pattern),
      value: pattern,
    });
    if (savedEntriesRef.current) {
      savedEntriesRef.current.open = true;
      savedEntriesRef.current.scrollIntoView({ block: "nearest" });
    }
  };
  const move = (index: number, direction: -1 | 1) => {
    if (!snapshot) return;
    const patterns = [...snapshot.saved.enabledModels];
    [patterns[index], patterns[index + direction]] = [
      patterns[index + direction]!,
      patterns[index]!,
    ];
    void save({ enabledModels: patterns });
  };
  const totalModels = useMemo(
    () =>
      snapshot?.providers.reduce(
        (count, provider) => count + provider.models.length,
        0,
      ) ?? 0,
    [snapshot],
  );
  const customConfiguration = snapshot ? (
    <details
      className="models-advanced-providers"
      open={declarationsOpen}
      onToggle={(event) => setDeclarationsOpen(event.currentTarget.open)}
    >
      <DetailSummary
        className="models-advanced-providers__summary"
        aria-label="Custom provider declarations"
      >
        <span>
          {snapshot.providers.length}{" "}
          {snapshot.providers.length === 1 ? "provider" : "providers"} ·{" "}
          {totalModels} {totalModels === 1 ? "model" : "models"}
        </span>
      </DetailSummary>
      {declarationsOpen ? (
        <div className="models-declarations">
          <p className="settings__field-help">
            Endpoints and model declarations in Pi's models.json.
          </p>
          <div className="models-declared-providers">
            {snapshot.providers.map((provider) => (
              <section
                className="models-provider-config"
                key={provider.id}
                aria-label={`Custom provider ${provider.id}`}
              >
                <div className="models-provider__heading">
                  <div>
                    <h4>{provider.id}</h4>
                    {provider.baseUrl || provider.api ? (
                      <small>
                        {[provider.baseUrl, provider.api]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    ) : null}
                  </div>
                  <div className="models-actions">
                    <button
                      type="button"
                      className="models-icon-button"
                      title="Edit provider"
                      aria-label={`Edit provider ${provider.id}`}
                      disabled={busy || configurationUnavailable}
                      onClick={(event) =>
                        openEditor(
                          { kind: "provider", value: provider },
                          event.currentTarget,
                        )
                      }
                    >
                      <Pencil size={14} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="models-icon-button"
                      title="Remove provider"
                      aria-label={`Remove provider configuration ${provider.id}`}
                      disabled={busy || configurationUnavailable}
                      onClick={(event) => {
                        removalOpener.current = event.currentTarget;
                        setRemoving({
                          kind: "remove-provider",
                          id: provider.id,
                        });
                      }}
                    >
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </div>
                </div>
                <div className="models-provider-models">
                  <details className="models-provider-models__disclosure">
                    <DetailSummary>
                      Models ({provider.models.length})
                    </DetailSummary>
                    <div className="models-declared-models">
                      {provider.models.map((model) => (
                        <div
                          className="models-declared-model"
                          key={JSON.stringify([model.type ?? "chat", model.id])}
                        >
                          <div className="models-declared-model__copy">
                            <span className="models-declared-model__name">
                              {model.name || model.id}
                            </span>
                            {model.name && model.name !== model.id ? (
                              <code>{model.id}</code>
                            ) : null}
                          </div>
                          <div className="models-actions">
                            <button
                              type="button"
                              className="models-icon-button"
                              title="Edit model"
                              aria-label={`Edit declared model ${provider.id}/${model.id}${model.type && model.type !== "chat" ? ` (${model.type})` : ""}`}
                              disabled={busy || configurationUnavailable}
                              onClick={(event) =>
                                openEditor(
                                  {
                                    kind: "model",
                                    provider: provider.id,
                                    value: model,
                                  },
                                  event.currentTarget,
                                )
                              }
                            >
                              <Pencil size={14} aria-hidden />
                            </button>
                            <button
                              type="button"
                              className="models-icon-button"
                              title="Remove model"
                              aria-label={`Remove model configuration ${provider.id}/${model.id}${model.type && model.type !== "chat" ? ` (${model.type})` : ""}`}
                              disabled={busy || configurationUnavailable}
                              onClick={(event) => {
                                removalOpener.current = event.currentTarget;
                                setRemoving({
                                  kind: "remove-model",
                                  provider: provider.id,
                                  id: model.id,
                                  type: model.type,
                                });
                              }}
                            >
                              <Trash2 size={14} aria-hidden />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                  <button
                    type="button"
                    className="button models-add-model"
                    aria-label={`Add model to ${provider.id}`}
                    disabled={busy || configurationUnavailable}
                    ref={(element) => {
                      if (element)
                        addModelRefs.current.set(provider.id, element);
                      else addModelRefs.current.delete(provider.id);
                    }}
                    onClick={(event) =>
                      openEditor(
                        { kind: "model", provider: provider.id, value: null },
                        event.currentTarget,
                      )
                    }
                  >
                    <Plus size={13} aria-hidden /> Add model
                  </button>
                </div>
              </section>
            ))}
          </div>
          {removing ? (
            <div className="models-confirm">
              <p>
                Remove the{" "}
                {removing.kind === "remove-provider"
                  ? `provider ${removing.id}`
                  : `model ${removing.provider}/${removing.id}`}{" "}
                declaration?
              </p>
              <div className="models-actions">
                <button
                  type="button"
                  className="button button--danger"
                  disabled={busy || configurationUnavailable}
                  onClick={() => void edit(removing)}
                >
                  Remove configuration
                </button>
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={busy}
                  onClick={() => {
                    setRemoving(null);
                    returnFocus(() => removalOpener.current);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  ) : null;
  return (
    <div className="models-settings-layout" ref={rootRef}>
      {editor ? (
        <section
          className="models-editor models-settings"
          aria-labelledby={editorTitleId}
        >
          <header className="models-editor__header">
            <button
              type="button"
              className="button button--quiet"
              onClick={cancelEditor}
              disabled={busy}
            >
              <ArrowLeft size={14} aria-hidden /> Back to models
            </button>
            <div>
              <h3 id={editorTitleId}>
                {editor.value ? "Edit" : "Add"} {editor.kind}
              </h3>
              {editor.kind === "model" || editor.value ? (
                <code>
                  {editor.kind === "model"
                    ? [editor.provider, editor.value?.id]
                        .filter(Boolean)
                        .join("/") +
                      (editor.value?.type && editor.value.type !== "chat"
                        ? ` (${editor.value.type})`
                        : "")
                    : editor.value?.id}
                </code>
              ) : null}
            </div>
          </header>
          {editor?.kind === "provider" ? (
            <ProviderForm
              key={JSON.stringify(["provider", editor.value?.id ?? null])}
              value={editor.value}
              busy={busy || configurationUnavailable}
              nativeApiProviders={snapshot?.nativeApiProviders ?? []}
              error={errorTarget === "config" ? error : null}
              onCancel={cancelEditor}
              onSave={edit}
            />
          ) : null}
          {editor?.kind === "model" ? (
            <ModelForm
              key={JSON.stringify([
                editor.provider,
                editor.value?.type ?? "chat",
                editor.value?.id ?? null,
              ])}
              provider={editor.provider}
              value={editor.value}
              busy={busy || configurationUnavailable}
              hasInheritedApi={hasInheritedApi}
              error={errorTarget === "config" ? error : null}
              onCancel={cancelEditor}
              onSave={edit}
            />
          ) : null}
        </section>
      ) : null}
      <div className="models-browse" hidden={Boolean(editor)}>
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
                      owner.sessionId,
                      owner.cwd,
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
                      <button
                        type="button"
                        className="models-icon-button"
                        aria-label="Refresh available models"
                        title="Refresh available models"
                        disabled={busy}
                        onClick={() => void load()}
                      >
                        <RefreshCw size={14} />
                      </button>
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
                            (savedModel !== null &&
                              modelIdentityKey(savedModel) ===
                                modelIdentityKey(inspectedModel))
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
                              !snapshot.models.some(
                                (entry) =>
                                  modelIdentityKey(entry) ===
                                  modelIdentityKey(savedModel),
                              )
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
                          !snapshot.models.some(
                            (entry) =>
                              modelIdentityKey(entry) ===
                              modelIdentityKey(savedModel),
                          )
                            ? " · Not currently available"
                            : ""
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
                        {!snapshot.models.some(
                          (entry) =>
                            modelIdentityKey(entry) ===
                            modelIdentityKey(savedModel),
                        ) ? (
                          <span className="models-default-value__warning">
                            · Not available now
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className="models-icon-button"
                          aria-label="Clear default model"
                          title="Clear default model"
                          disabled={busy}
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

                {snapshot.saved.enabledModels.length ? (
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
                          {editingCommon?.index === index ? (
                            <form
                              className="models-common__editor"
                              onSubmit={(event) => {
                                event.preventDefault();
                                const next = [...snapshot.saved.enabledModels];
                                next[index] = editingCommon.value.trim();
                                if (next[index])
                                  void save({ enabledModels: next });
                              }}
                            >
                              <label className="models-form__field">
                                Model pattern
                                <input
                                  aria-label="Model pattern"
                                  value={editingCommon.value}
                                  disabled={busy}
                                  onChange={(event) =>
                                    setEditingCommon({
                                      index,
                                      value: event.target.value,
                                    })
                                  }
                                  autoFocus
                                />
                              </label>
                              {errorTarget === "common" && error ? (
                                <p
                                  className="settings__error"
                                  role="alert"
                                  tabIndex={-1}
                                >
                                  {error}
                                </p>
                              ) : null}
                              <div className="models-actions">
                                <button
                                  type="submit"
                                  className="button"
                                  disabled={busy || !editingCommon.value.trim()}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  className="button button--quiet"
                                  disabled={busy}
                                  onClick={() => {
                                    setEditingCommon(null);
                                    returnFocus(() => commonOpener.current);
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </form>
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
