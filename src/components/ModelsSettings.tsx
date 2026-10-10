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
  active = true,
}: {
  destination?: ModelSettingsDestination;
  active?: boolean;
}) {
  const activeRef = useRef(active);
  activeRef.current = active;
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
  const defaultGroupName = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const savedEntriesRef = useRef<HTMLDetailsElement>(null);
  const editorOpener = useRef<HTMLElement | null>(null);
  const editorFromList = useRef(false);
  const editorTitleId = useId();
  const browseScroll = useRef(0);
  const wasEditing = useRef(false);
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
        if (entry.contentRect.width > 0) setListWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasSnapshot]);
  const isTouch = window.matchMedia("(pointer: coarse)").matches;
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
        activeRef.current &&
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
    if (busy || !focusHandoff) return;
    if (focusHandoff.ticket.allowed()) focusHandoff.focus(focusHandoff.ticket);
    else focusHandoff.ticket.release();
    setFocusHandoff(null);
  }, [busy, focusHandoff]);
  const openEditor = (next: typeof editor, opener: HTMLElement) => {
    editorOpener.current = opener;
    editorFromList.current = Boolean(opener.closest(".models-available"));
    browseScroll.current =
      rootRef.current?.closest(".settings__content")?.scrollTop ?? 0;
    setError(null);
    setEditor(next);
    setRemoving(null);
  };
  const focusEditorOrigin = (
    ticket: FocusTicket,
    model?: { provider: string; id: string },
  ) => {
    if (
      editorFromList.current &&
      editor?.kind === "model" &&
      editor.value &&
      availableListRef.current
    ) {
      availableListRef.current.focusModel(
        model ?? { provider: editor.provider, id: editor.value.id },
        ticket.allowed,
        ticket.release,
        { action: "edit", preserveQuery: true },
      );
    } else focusElement(ticket, editorOpener.current);
  };
  const cancelEditor = () => {
    const ticket = captureFocus();
    setError(null);
    setEditor(null);
    setFocusHandoff({
      ticket,
      focus: (ticket) => focusEditorOrigin(ticket),
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
        if (warning && owns()) setError(warning);
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
          edit.kind === "provider" &&
          editor?.kind === "provider" &&
          !editor.value
        ) {
          setDeclarationsOpen(true);
        }
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
        if (edit.kind === "model" && edit.originalId) {
          return (ticket) =>
            focusEditorOrigin(ticket, {
              provider: edit.provider,
              id: edit.values.id,
            });
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
                  className="button button--quiet"
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
              busy={busy}
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
              busy={busy}
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
                        ? `This project uses ${snapshot.effective.defaultThinkingLevel ?? "Model default"}.`
                        : undefined
                    }
                  >
                    <Dropdown
                      label="Default thinking"
                      className="dropdown--field"
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
                  <details
                    ref={savedEntriesRef}
                    className="models-saved-entries"
                  >
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
                                  className="button button--quiet"
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
    </div>
  );
}
