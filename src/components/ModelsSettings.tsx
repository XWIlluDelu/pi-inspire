import {
  ArrowDown,
  ArrowUp,
  Check,
  Cpu,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
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
  ModelSettingsSnapshot,
  ModelSettingsWriteResult,
  ProviderDeclaration,
  ProviderLoginOption,
} from "../../shared/model-settings";
import { shallowEqual, store, useAppState } from "../store";
import { Dropdown } from "./Dropdown";
import { ModelForm, ProviderForm } from "./ModelDeclarationForms";
import { ModelList, type ModelListHandle } from "./ModelList";
import { ProviderAuthentication } from "./ProviderAuthentication";
import { SettingField } from "./SettingsControls";
import { SettingsSection } from "./SettingsSection";

type Owner = { sessionId?: string; cwd?: string };
type FocusTicket = {
  origin: HTMLElement | null;
  allowed: () => boolean;
  release: () => void;
};
type FocusPlan = (ticket: FocusTicket) => void;
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The Host could not complete this operation";
export function ModelsSettings({
  destination,
}: {
  destination?: ModelSettingsDestination;
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
  const [snapshot, setSnapshot] = useState<ModelSettingsSnapshot | null>(null);
  const [providers, setProviders] = useState<ProviderLoginOption[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [errorTarget, setErrorTarget] = useState<"config" | "common" | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
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
  const commonOpener = useRef<HTMLElement | null>(null);
  const addProviderRef = useRef<HTMLButtonElement>(null);
  const addModelRefs = useRef(new Map<string, HTMLButtonElement>());
  const removalOpener = useRef<HTMLElement | null>(null);
  const availableListRef = useRef<ModelListHandle>(null);
  const availableContainerRef = useRef<HTMLDivElement>(null);
  const [listWidth, setListWidth] = useState(500);
  const hasSnapshot = snapshot !== null;
  useEffect(() => {
    const el = availableContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setListWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasSnapshot]);
  const isTouch =
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: coarse)").matches;
  const optionSize = listWidth <= 400 ? (isTouch ? 64 : 56) : 48;
  const focusTicketRef = useRef<FocusTicket | null>(null);
  const [focusHandoff, setFocusHandoff] = useState<{
    ticket: FocusTicket;
    focus: FocusPlan;
  } | null>(null);
  const currentOwner = useRef({ owner, transport: state.transport });
  currentOwner.current = { owner, transport: state.transport };
  const mounted = useRef(false),
    generation = useRef(0),
    providerGeneration = useRef(0);
  const captureFocus = (): FocusTicket => {
    focusTicketRef.current?.release();
    const origin =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    let moved = !rootRef.current?.contains(origin),
      released = false;
    const observe = (event: FocusEvent) => {
      if (event.target !== origin && event.target !== document.body)
        moved = true;
    };
    document.addEventListener("focusin", observe, true);
    const ticket: FocusTicket = {
      origin,
      allowed: () =>
        !released &&
        !moved &&
        mounted.current &&
        Boolean(rootRef.current?.isConnected) &&
        currentOwner.current.owner === owner &&
        currentOwner.current.transport === state.transport,
      release: () => {
        released = true;
        document.removeEventListener("focusin", observe, true);
      },
    };
    focusTicketRef.current = ticket;
    return ticket;
  };
  const focusElement = (ticket: FocusTicket, element: HTMLElement | null) => {
    const target =
      element?.isConnected && !element.matches(":disabled")
        ? element
        : rootRef.current?.querySelector<HTMLElement>(
            '[aria-label="Search available models"]',
          );
    const allowed = ticket.allowed();
    ticket.release();
    if (allowed) target?.focus();
  };
  useLayoutEffect(() => {
    if (busy || !focusHandoff) return;
    if (focusHandoff.ticket.allowed()) focusHandoff.focus(focusHandoff.ticket);
    else focusHandoff.ticket.release();
    setFocusHandoff(null);
  }, [busy, focusHandoff]);
  const openEditor = (next: typeof editor, opener: HTMLElement) => {
    editorOpener.current = opener;
    setError(null);
    setEditor(next);
    setRemoving(null);
    setDeclarationsOpen(true);
  };
  const cancelEditor = () => {
    const ticket = captureFocus();
    setError(null);
    setEditor(null);
    setFocusHandoff({
      ticket,
      focus: (ticket) => focusElement(ticket, editorOpener.current),
    });
  };
  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const settings = await store.readModelSettings(owner);
      if (generation.current !== current) return;
      setSnapshot(settings);
      setReadFailed(false);
      setError(null);
    } catch (error) {
      if (generation.current === current) {
        setReadFailed(true);
        setError(messageOf(error));
      }
    }
  }, [owner, state.transport]);
  const refreshProviders = useCallback(async () => {
    const owns = () =>
      mounted.current &&
      currentOwner.current.owner === owner &&
      currentOwner.current.transport === state.transport;
    if (!owns()) return;
    const current = ++providerGeneration.current;
    setProvidersLoading(true);
    try {
      const auth = await store.providerAuth(owner, { operation: "providers" });
      if (owns() && providerGeneration.current === current) {
        setProviders(auth as ProviderLoginOption[]);
        setProvidersLoaded(true);
        setAuthError(null);
      }
    } catch (error) {
      if (owns() && providerGeneration.current === current)
        setAuthError(messageOf(error));
    } finally {
      if (owns() && providerGeneration.current === current)
        setProvidersLoading(false);
    }
  }, [owner, state.transport]);
  const refreshChoices = useCallback(async () => {
    const owns = () =>
      mounted.current &&
      currentOwner.current.owner === owner &&
      currentOwner.current.transport === state.transport;
    if (!owns()) return;
    try {
      const warning = await store.refreshModels(owner);
      if (owns()) {
        await load();
        if (warning) setError(warning);
      }
    } catch (error) {
      if (owns()) setError(messageOf(error));
    }
  }, [owner, state.transport, load]);
  useEffect(() => {
    mounted.current = true;
    setSnapshot(null);
    setReadFailed(false);
    setProviders([]);
    setAuthError(null);
    setProvidersLoading(true);
    setProvidersLoaded(false);
    setError(null);
    setEditingCommon(null);
    setEditor(null);
    setRemoving(null);
    setBusy(false);
    setDeclarationsOpen(false);
    void load();
    void refreshProviders();
    void refreshChoices();
    return () => {
      mounted.current = false;
      focusTicketRef.current?.release();
      ++generation.current;
      ++providerGeneration.current;
    };
  }, [load, refreshProviders, refreshChoices]);
  const focusedDestination = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = `${destination?.focus ?? ""}/${destination?.query ?? ""}`;
    if (!snapshot || !destination?.focus || focusedDestination.current === key)
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
  }, [snapshot, destination]);
  const mutate = async (
    operation: () => Promise<ModelSettingsWriteResult>,
    onSaved?: (next: ModelSettingsWriteResult) => FocusPlan,
    target: "config" | "common" | null = null,
  ): Promise<boolean> => {
    if (busy) return false;
    const owns = () =>
      mounted.current &&
      currentOwner.current.owner === owner &&
      currentOwner.current.transport === state.transport;
    const ticket = captureFocus();
    let focus: FocusPlan = (ticket) => focusElement(ticket, ticket.origin);
    ++generation.current;
    setBusy(true);
    setError(null);
    setErrorTarget(target);
    try {
      const next = await operation();
      if (!owns()) return false;
      ++generation.current;
      if (next.snapshot) {
        setSnapshot(next.snapshot);
        setReadFailed(false);
      }
      setError(next.warning ?? null);
      setErrorTarget(null);
      if (onSaved) focus = onSaved(next);
      return true;
    } catch (error) {
      if (owns()) {
        setError(messageOf(error));
        if (target)
          focus = (ticket) =>
            focusElement(
              ticket,
              rootRef.current?.querySelector<HTMLElement>(
                target === "config"
                  ? '.models-form [role="alert"]'
                  : '.models-common__editor [role="alert"]',
              ) ?? ticket.origin,
            );
      }
      return false;
    } finally {
      if (owns()) {
        setBusy(false);
        setFocusHandoff({ ticket, focus });
      } else ticket.release();
    }
  };
  const save = async (patch: ModelPreferencesPatch) => {
    if (!snapshot) return false;
    return mutate(
      () => store.saveModelPreferences(owner, snapshot.settingsRevision, patch),
      () => {
        const target =
          patch.enabledModels && editingCommon
            ? commonOpener.current
            : (focusTicketRef.current?.origin ?? null);
        if (patch.enabledModels) setEditingCommon(null);
        return (ticket) =>
          focusElement(
            ticket,
            patch.defaultModel === null
              ? (rootRef.current?.querySelector<HTMLButtonElement>(
                  '.models-results [role="combobox"]',
                ) ?? null)
              : target,
          );
      },
      editingCommon ? "common" : null,
    );
  };
  const edit = async (edit: ModelConfigEdit) => {
    if (!snapshot) return false;
    const saved = await mutate(
      () => store.editModelConfig(owner, snapshot.configRevision, edit),
      (next) => {
        setEditor(null);
        setRemoving(null);
        if (
          edit.kind === "model" &&
          !edit.originalId &&
          next.snapshot?.models.some(
            (model) =>
              model.provider === edit.provider && model.id === edit.values.id,
          )
        ) {
          return (ticket) => {
            if (availableListRef.current)
              availableListRef.current.focusModel(
                { provider: edit.provider, id: edit.values.id },
                ticket.allowed,
                ticket.release,
              );
            else focusElement(ticket, editorOpener.current);
          };
        }
        return (ticket) =>
          focusElement(
            ticket,
            (edit.kind === "provider" &&
              editor?.kind === "provider" &&
              !editor.value) ||
              edit.kind === "remove-model"
              ? (addModelRefs.current.get(
                  edit.kind === "provider" ? edit.id : edit.provider,
                ) ?? addProviderRef.current)
              : edit.kind === "remove-provider"
                ? addProviderRef.current
                : editorOpener.current,
          );
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
  const projectModelOverride = snapshot?.projectOverrides.some(
    (field) => field === "defaultModel" || field === "defaultProvider",
  );
  const projectModel = snapshot?.effective.defaultModel;
  const modelProvider =
    editor?.kind === "model"
      ? snapshot?.providers.find((provider) => provider.id === editor.provider)
      : undefined;
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
    snapshot?.configError;
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
    <div className="models-advanced-providers">
      <div className="models-advanced-providers__summary">
        <span>
          {snapshot.providers.length}{" "}
          {snapshot.providers.length === 1 ? "provider" : "providers"} ·{" "}
          {totalModels} {totalModels === 1 ? "model" : "models"}
        </span>
        <button
          type="button"
          className="models-text-button"
          aria-expanded={declarationsOpen}
          onClick={() => setDeclarationsOpen((open) => !open)}
        >
          {declarationsOpen ? "Hide" : "Show"}
        </button>
      </div>
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
                      className="models-text-button"
                      aria-label={`Edit provider ${provider.id}`}
                      disabled={busy}
                      onClick={(event) =>
                        openEditor(
                          { kind: "provider", value: provider },
                          event.currentTarget,
                        )
                      }
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="models-text-button"
                      aria-label={`Remove provider configuration ${provider.id}`}
                      disabled={busy}
                      onClick={(event) => {
                        removalOpener.current = event.currentTarget;
                        setRemoving({
                          kind: "remove-provider",
                          id: provider.id,
                        });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <div className="models-provider-models">
                  <details className="models-provider-models__disclosure">
                    <summary>Models ({provider.models.length})</summary>
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
                              className="models-text-button"
                              aria-label={`Edit declared model ${provider.id}/${model.id}${model.type && model.type !== "chat" ? ` (${model.type})` : ""}`}
                              disabled={busy}
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
                              Edit
                            </button>
                            <button
                              type="button"
                              className="models-text-button"
                              aria-label={`Remove model configuration ${provider.id}/${model.id}${model.type && model.type !== "chat" ? ` (${model.type})` : ""}`}
                              disabled={busy}
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
                              Remove
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
                    disabled={busy}
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
          {editor?.kind === "provider" ? (
            <ProviderForm
              key={JSON.stringify(["provider", editor.value?.id ?? null])}
              value={editor.value}
              busy={busy}
              nativeApiProviders={snapshot.nativeApiProviders ?? []}
              error={errorTarget === "config" ? error : null}
              onCancel={cancelEditor}
              onSave={edit}
            />
          ) : null}
          {editor?.kind === "model" ? (
            <div className="models-model-editor">
              <ModelForm
                key={JSON.stringify([
                  editor.provider,
                  editor.value?.type ?? "chat",
                  editor.value?.id ?? null,
                ])}
                provider={editor.provider}
                value={editor.value}
                busy={busy}
                hasInheritedApi={hasInheritedApi}
                error={errorTarget === "config" ? error : null}
                onCancel={cancelEditor}
                onSave={edit}
              />
            </div>
          ) : null}
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
                  disabled={busy}
                  onClick={async () => {
                    if (await edit(removing)) {
                      setRemoving(null);
                      setEditor(null);
                    }
                  }}
                >
                  Remove configuration
                </button>
                <button
                  type="button"
                  className="models-text-button"
                  disabled={busy}
                  onClick={() => {
                    const ticket = captureFocus();
                    setRemoving(null);
                    setFocusHandoff({
                      ticket,
                      focus: (ticket) =>
                        focusElement(ticket, removalOpener.current),
                    });
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null;
  return (
    <div className="models-settings-layout" ref={rootRef}>
      <SettingsSection id="models" icon={<Cpu size={14} />} title="Models">
        <div className="models-settings">
          {visibleError ? (
            <p className="settings__error" role="alert">
              {visibleError}
            </p>
          ) : null}
          {snapshot ? (
            <>
              <div className="models-available" ref={availableContainerRef}>
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
                  controllerRef={availableListRef}
                  models={snapshot.models}
                  value={savedModel}
                  placeholder="Search models"
                  optionSize={optionSize}
                  searchAction={
                    <button
                      type="button"
                      className="models-icon-button"
                      aria-label="Refresh available models"
                      title="Refresh available models"
                      disabled={busy}
                      onClick={() => void refreshChoices()}
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
                  renderNameAction={(model, active) => {
                    const declared = snapshot.providers
                      .find((provider) => provider.id === model.provider)
                      ?.models.find(
                        (entry) =>
                          entry.id === model.id &&
                          (!entry.type || entry.type === "chat"),
                      );
                    return declared ? (
                      <button
                        type="button"
                        className="models-icon-button models-name-action"
                        tabIndex={active ? 0 : -1}
                        disabled={busy}
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
                      modelIdentityKey(savedModel) === modelIdentityKey(model);
                    return (
                      <>
                        <button
                          type="button"
                          className={`models-chip ${patterns.length ? "models-chip--pattern" : ""}`}
                          tabIndex={active ? 0 : -1}
                          disabled={busy || preferencesUnavailable}
                          aria-pressed={Boolean(sources.length)}
                          title={
                            patterns.length
                              ? "Included by a rule — edit rule"
                              : undefined
                          }
                          aria-label={
                            patterns.length
                              ? `Edit common pattern for ${model.name ?? model.id}`
                              : `${exact.length ? "Remove" : "Add"} ${model.name ?? model.id} ${exact.length ? "from" : "to"} common`
                          }
                          onClick={(event) => {
                            if (patterns.length)
                              editCommon(patterns[0]!, event.currentTarget);
                            else
                              void save({
                                enabledModels: exact.length
                                  ? snapshot.saved.enabledModels.filter(
                                      (entry) => !exact.includes(entry),
                                    )
                                  : [...snapshot.saved.enabledModels, identity],
                              });
                          }}
                        >
                          {sources.length ? (
                            <Check size={12} aria-hidden />
                          ) : null}
                          Common
                        </button>
                        <button
                          type="button"
                          className="models-chip"
                          tabIndex={active ? 0 : -1}
                          disabled={busy || preferencesUnavailable}
                          aria-pressed={Boolean(selected)}
                          aria-label={
                            selected
                              ? `Clear default ${model.name ?? model.id}`
                              : `Set ${model.name ?? model.id} as default`
                          }
                          onClick={() =>
                            void save({
                              defaultModel: selected
                                ? null
                                : { provider: model.provider, id: model.id },
                            })
                          }
                        >
                          {selected ? <Check size={12} aria-hidden /> : null}
                          Default
                        </button>
                      </>
                    );
                  }}
                />
              </div>

              <div className="models-results">
                <SettingField
                  label="Default model"
                  className={
                    savedModel
                      ? "models-default-row"
                      : "models-default-row--empty"
                  }
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
                        : "Choose Default on a model above."
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
                        className="models-text-button"
                        aria-label="Clear default model"
                        disabled={busy}
                        onClick={() => void save({ defaultModel: null })}
                      >
                        Clear
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
                      ? `This project uses ${snapshot.effective.defaultThinkingLevel ?? "Model default"}.`
                      : undefined
                  }
                >
                  <Dropdown
                    label="Default thinking"
                    className="dropdown--field dropdown--described"
                    value={snapshot.saved.defaultThinkingLevel ?? "unset"}
                    display={preferencesUnavailable ? "Unavailable" : undefined}
                    disabled={busy || preferencesUnavailable}
                    options={[
                      {
                        value: "unset",
                        label: "Model default",
                        description: "Use each model's own setting.",
                      },
                      ...THINKING_LEVELS.map((level) => ({
                        value: level,
                        label: level,
                      })),
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
                <details ref={savedEntriesRef} className="models-saved-entries">
                  <summary>
                    Common order and rules (
                    {snapshot.saved.enabledModels.length})
                  </summary>
                  <p
                    className="settings__field-help"
                    style={{ padding: "var(--space-2) var(--space-3) 0" }}
                  >
                    Order used when cycling models. Rules can match several
                    models.
                  </p>
                  {snapshot.projectOverrides.includes("enabledModels") ? (
                    <p
                      className="settings__field-help"
                      style={{ padding: "var(--space-1) var(--space-3) 0" }}
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
                                className="models-text-button"
                                disabled={busy}
                                onClick={() => {
                                  const ticket = captureFocus();
                                  setEditingCommon(null);
                                  setFocusHandoff({
                                    ticket,
                                    focus: (ticket) =>
                                      focusElement(
                                        ticket,
                                        commonOpener.current,
                                      ),
                                  });
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
              className="button"
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
            destination?.focus === "credentials" ? destination.query : undefined
          }
          discover={destination?.focus === "credentials"}
          loadError={authError}
          loading={providersLoading}
          loaded={providersLoaded}
          onRefresh={refreshProviders}
          onModelsRefreshed={load}
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
              disabled={busy}
              ref={addProviderRef}
              onClick={(event) =>
                openEditor(
                  { kind: "provider", value: null },
                  event.currentTarget,
                )
              }
            >
              <Plus size={13} aria-hidden /> Add provider
            </button>
          }
        >
          <div className="models-settings">{customConfiguration}</div>
        </SettingsSection>
      ) : null}
    </div>
  );
}
