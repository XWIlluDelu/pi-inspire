import { ArrowLeft, CircleHelp, Eye, EyeOff, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ProviderLoginAttempt,
  ProviderLoginOption,
} from "../../shared/model-settings";
import { store } from "../store";

type Owner = { sessionId?: string; cwd?: string };
type ProviderView = { kind: "saved" | "connect"; provider?: string };
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The Host could not complete this operation";

function RemoteLoginHelp({ instruction }: { instruction: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className="models-remote">
      <span>Remote login</span>
      <button
        type="button"
        className="models-icon-button models-remote__toggle"
        aria-label="About remote login"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <CircleHelp size={14} aria-hidden />
      </button>
      {open ? (
        <span id={id} className="models-remote__help">
          {instruction}
        </span>
      ) : null}
    </span>
  );
}

type AuthenticationProps = {
  owner: Owner;
  providers: ProviderLoginOption[];
  onRefresh: () => Promise<void>;
  onModelsRefreshed?: () => Promise<void>;
  initialQuery?: string;
  discover?: boolean;
  loadError?: string | null;
  loading?: boolean;
  loaded?: boolean;
};

export function ProviderAuthentication(props: AuthenticationProps) {
  // Reconnecting to the same Host does not retire its pending login. Only a
  // different settings owner starts a clean interaction lifetime.
  return (
    <AuthenticationPanel
      key={JSON.stringify([props.owner.sessionId, props.owner.cwd])}
      {...props}
    />
  );
}

function AuthenticationPanel({
  owner: requestedOwner,
  providers,
  onRefresh,
  onModelsRefreshed,
  initialQuery = "",
  discover = false,
  loadError,
  loading = false,
  loaded = true,
}: AuthenticationProps) {
  const owner = useMemo(
    () => ({
      ...(requestedOwner.sessionId
        ? { sessionId: requestedOwner.sessionId }
        : {}),
      ...(requestedOwner.cwd ? { cwd: requestedOwner.cwd } : {}),
    }),
    [requestedOwner.sessionId, requestedOwner.cwd],
  );
  const [query, setQuery] = useState(initialQuery);
  const [view, setView] = useState<ProviderView>({
    kind: discover || initialQuery ? "connect" : "saved",
  });
  const discovering = view.kind === "connect";
  const selected = discovering ? view.provider : undefined;
  const [attempt, setAttempt] = useState<ProviderLoginAttempt | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [showInput, setShowInput] = useState(false);
  const inputId = useId();
  const directoryId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const targetQuery = initialQuery.trim().toLowerCase();
  const targetMatches = targetQuery
    ? providers.filter((provider) =>
        `${provider.id} ${provider.name}`.toLowerCase().includes(targetQuery),
      )
    : [];
  const targetProvider =
    targetMatches.find(
      (provider) =>
        provider.id.toLowerCase() === targetQuery ||
        provider.name.toLowerCase() === targetQuery,
    ) ?? (targetMatches.length === 1 ? targetMatches[0] : undefined);
  const targetId = targetProvider?.id;
  const targetSaved = Boolean(targetProvider?.stored);
  useEffect(() => {
    setQuery(initialQuery);
    setView(
      targetId
        ? { kind: targetSaved ? "saved" : "connect", provider: targetId }
        : { kind: discover || initialQuery ? "connect" : "saved" },
    );
  }, [initialQuery, discover, targetId, targetSaved]);
  const mounted = useRef(false);
  const mutationRevision = useRef(0);
  const attemptRef = useRef<ProviderLoginAttempt | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const update = useCallback((next: ProviderLoginAttempt | null) => {
    attemptRef.current = next;
    setAttempt(next);
  }, []);
  const attemptId = attempt?.id;
  const attemptStatus = attempt?.status;
  const promptId = attempt?.prompt?.id;
  const promptType = attempt?.prompt?.type;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const pending = attemptRef.current;
      if (pending?.status === "pending")
        void store
          .providerAuth(owner, { operation: "cancel", id: pending.id })
          .catch(() => {});
    };
  }, [owner]);
  useEffect(() => {
    setInput("");
    setShowInput(false);
    if (promptId && promptType !== "select") inputRef.current?.focus();
  }, [promptId, promptType]);
  useEffect(() => {
    if (!attemptId || attemptStatus !== "pending") return;
    let observing = true;
    let timer: ReturnType<typeof setTimeout>;
    let pollError: string | null = null;
    const poll = async () => {
      const revision = mutationRevision.current;
      try {
        const next = (await store.providerAuth(owner, {
          operation: "status",
          id: attemptId,
        })) as ProviderLoginAttempt;
        if (!observing) return;
        // A pending read started before a prompt mutation must not restore its
        // old prompt. Terminal receipts are authoritative and always settle it.
        if (
          next.status === "pending" &&
          mutationRevision.current !== revision
        ) {
          timer = setTimeout(() => void poll(), 750);
          return;
        }
        if (pollError) {
          const recovered = pollError;
          setError((error) => (error === recovered ? null : error));
          pollError = null;
        }
        if (next.status !== "pending") setError(null);
        update(next);
        if (next.status === "pending")
          timer = setTimeout(() => void poll(), 750);
      } catch (error) {
        if (!observing) return;
        pollError = messageOf(error);
        setError(pollError);
        timer = setTimeout(() => void poll(), 750);
      }
    };
    timer = setTimeout(() => void poll(), 250);
    return () => {
      observing = false;
      clearTimeout(timer);
    };
  }, [attemptId, attemptStatus, owner, update]);
  useEffect(() => {
    if (attemptStatus !== "completed" && attemptStatus !== "failed") return;
    void onRefresh()
      .then(() => {
        if (mounted.current) return store.refreshModels(owner);
      })
      .then(() => {
        if (mounted.current) return onModelsRefreshed?.();
      })
      .catch((error) => {
        if (mounted.current) setError(messageOf(error));
      });
  }, [attemptId, attemptStatus, owner, onRefresh, onModelsRefreshed]);
  const start = async (provider: string, type: "api_key" | "oauth") => {
    if (busy || attemptRef.current?.status === "pending") return;
    setBusy(true);
    setError(null);
    setRemoving(null);
    try {
      const next = (await store.providerAuth(owner, {
        operation: "start",
        provider,
        type,
      })) as ProviderLoginAttempt;
      if (!mounted.current) {
        if (next.status === "pending")
          void store
            .providerAuth(owner, { operation: "cancel", id: next.id })
            .catch(() => {});
        return;
      }
      update(next);
    } catch (error) {
      if (mounted.current) setError(messageOf(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const answer = async (value: string) => {
    if (!attempt?.prompt || busy) return;
    ++mutationRevision.current;
    const promptId = attempt.prompt.id;
    setBusy(true);
    setError(null);
    try {
      const next = (await store.providerAuth(owner, {
        operation: "answer",
        id: attempt.id,
        promptId,
        value,
      })) as ProviderLoginAttempt;
      const live = attemptRef.current;
      if (
        mounted.current &&
        live?.id === attempt.id &&
        live.status === "pending" &&
        (!live.prompt || live.prompt.id === promptId)
      ) {
        update(next);
        setInput("");
      }
    } catch (error) {
      if (mounted.current) setError(messageOf(error));
    } finally {
      ++mutationRevision.current;
      if (mounted.current) setBusy(false);
    }
  };
  const cancel = async () => {
    if (!attempt || busy) return;
    ++mutationRevision.current;
    setBusy(true);
    setError(null);
    try {
      const next = (await store.providerAuth(owner, {
        operation: "cancel",
        id: attempt.id,
      })) as ProviderLoginAttempt | null;
      if (mounted.current) update(next);
    } catch (error) {
      if (mounted.current) setError(messageOf(error));
    } finally {
      ++mutationRevision.current;
      if (mounted.current) setBusy(false);
    }
  };
  const logout = async (provider: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await store.providerAuth(owner, { operation: "logout", provider });
      if (!mounted.current) return;
      setRemoving(null);
      setView({ kind: "saved" });
      if (attempt?.provider === provider) update(null);
      await onRefresh();
      if (mounted.current) await store.refreshModels(owner);
      if (mounted.current) await onModelsRefreshed?.();
    } catch (error) {
      if (mounted.current) setError(messageOf(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const filtered = providers.filter((provider) =>
    `${provider.id} ${provider.name}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const saved = providers.filter((provider) => provider.stored);
  const available = filtered.filter((provider) => !provider.stored);
  useEffect(() => {
    if (!discovering || attempt) return;
    if (selected) backRef.current?.focus();
    else searchRef.current?.focus();
  }, [discovering, selected, attempt]);
  const providerRow = (provider: ProviderLoginOption, forceOpen = false) => {
    const open = forceOpen || view.provider === provider.id;
    const disclosureId = `${inputId}-provider-${provider.id}`;
    return (
      <div className="models-provider-login" key={provider.id}>
        <div className="models-provider-login__heading">
          <div className="models-provider-login__copy">
            <strong>{provider.name}</strong>
            {provider.stored ? (
              <span className="settings__field-help">
                {provider.stored === "api_key"
                  ? "API key configured"
                  : "Signed in"}
              </span>
            ) : null}
          </div>
          {!forceOpen ? (
            <button
              type="button"
              className="button models-provider-disclosure"
              aria-label={`${provider.stored ? "Manage" : "Set up"} ${provider.name}`}
              aria-expanded={provider.stored ? open : undefined}
              aria-controls={provider.stored ? disclosureId : undefined}
              disabled={busy}
              onClick={() => {
                setView({
                  kind: provider.stored ? "saved" : "connect",
                  provider: open ? undefined : provider.id,
                });
                setRemoving(null);
              }}
            >
              {provider.stored ? "Manage" : "Set up"}
            </button>
          ) : null}
        </div>
        {open ? (
          <div id={disclosureId} className="models-provider-login__details">
            <div className="models-provider-login__actions">
              <div className="models-provider-login__methods-row">
                {provider.methods.map((method) => (
                  <div className="models-login__method" key={method.type}>
                    <button
                      type="button"
                      className="button"
                      disabled={busy || attempt?.status === "pending"}
                      onClick={() => void start(provider.id, method.type)}
                    >
                      {method.label}
                    </button>
                    {method.remoteHelp ? (
                      <RemoteLoginHelp instruction={method.remoteHelp} />
                    ) : null}
                  </div>
                ))}
              </div>
              {provider.stored ? (
                <button
                  type="button"
                  className="models-remove-credential"
                  disabled={busy || attempt?.status === "pending"}
                  aria-label={`Remove saved credentials for ${provider.name}`}
                  onClick={() => setRemoving(provider.id)}
                >
                  Remove
                </button>
              ) : null}
            </div>
            {removing === provider.id ? (
              <div
                className="models-confirm"
                role="group"
                aria-label="Remove saved credential"
              >
                <p>
                  Remove the saved{" "}
                  {provider.stored === "api_key" ? "API key" : "login"} for{" "}
                  {provider.name}?
                </p>
                <div className="models-actions">
                  <button
                    className="button button--danger"
                    type="button"
                    disabled={busy}
                    onClick={() => void logout(provider.id)}
                  >
                    Remove saved credentials
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    onClick={() => setRemoving(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <div className="models-auth" id="model-provider-credentials">
      {error ? (
        <p className="models-status" role="alert">
          {error}
        </p>
      ) : null}
      {loadError ? (
        <p className="models-status" role="alert">
          {loaded ? "Provider refresh failed" : "Failed to load providers"}:{" "}
          {loadError}
        </p>
      ) : null}
      {loading ? (
        <p className="models-status" role="status">
          Loading providers…
        </p>
      ) : null}
      {loadError ? (
        <button
          type="button"
          className="button"
          onClick={() =>
            void onRefresh().catch((error) => setError(messageOf(error)))
          }
        >
          Retry
        </button>
      ) : null}
      {attempt ? (
        <div
          className="models-login"
          role="group"
          aria-label={`Login to ${attempt.provider}`}
        >
          <div className="models-subheading">
            <h4>
              {providers.find((provider) => provider.id === attempt.provider)
                ?.name ?? attempt.provider}
            </h4>
            <span className="models-status" role="status">
              {attempt.status === "pending"
                ? "Login in progress"
                : attempt.message}
            </span>
          </div>
          {attempt.events
            .filter((event) => event.type !== "progress")
            .map((event, index) => (
              <div
                key={`${index}-${event.type}`}
                className="models-login__event"
              >
                {event.message ? <p>{event.message}</p> : null}
                {event.url ? (
                  <a href={event.url} target="_blank" rel="noopener noreferrer">
                    Open sign-in link
                  </a>
                ) : null}
                {event.userCode ? (
                  <p className="models-login__code">{event.userCode}</p>
                ) : null}
                {event.type === "device_code" ? (
                  <RemoteLoginHelp instruction="Open the sign-in link on this device and enter the displayed code." />
                ) : null}
                {event.links?.map((link) => (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {link.label ?? "Open link"}
                  </a>
                ))}
              </div>
            ))}
          {attempt.events.at(-1)?.type === "progress" ? (
            <p role="status" className="settings__field-help">
              {attempt.events.at(-1)?.message}
            </p>
          ) : null}
          {attempt.prompt ? (
            attempt.prompt.type === "select" ? (
              <div
                className="models-login__methods"
                role="group"
                aria-label={attempt.prompt.message}
              >
                <p>{attempt.prompt.message}</p>
                {attempt.prompt.options?.map((option) => (
                  <div className="models-login__method" key={option.id}>
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => void answer(option.id)}
                    >
                      {option.label}
                    </button>
                    {option.remoteHelp ? (
                      <RemoteLoginHelp instruction={option.remoteHelp} />
                    ) : null}
                    {option.description ? (
                      <p className="settings__field-help">
                        {option.description}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <form
                className="models-login__input"
                onSubmit={(event) => {
                  event.preventDefault();
                  void answer(input);
                }}
              >
                <label htmlFor={inputId}>{attempt.prompt.message}</label>
                <div className="models-secret-input">
                  <input
                    id={inputId}
                    ref={inputRef}
                    type={
                      !showInput &&
                      (attempt.prompt.type === "secret" ||
                        attempt.prompt.type === "manual_code")
                        ? "password"
                        : "text"
                    }
                    value={input}
                    autoComplete="off"
                    placeholder={attempt.prompt.placeholder}
                    disabled={busy}
                    onChange={(event) => setInput(event.target.value)}
                  />
                  {attempt.prompt.type === "secret" ||
                  attempt.prompt.type === "manual_code" ? (
                    <button
                      type="button"
                      className="models-icon-button"
                      aria-label={
                        showInput ? "Hide credential" : "Show credential"
                      }
                      aria-pressed={showInput}
                      onClick={() => setShowInput((value) => !value)}
                    >
                      {showInput ? (
                        <EyeOff size={16} aria-hidden />
                      ) : (
                        <Eye size={16} aria-hidden />
                      )}
                    </button>
                  ) : null}
                </div>
                <button
                  className="button button--primary"
                  type="submit"
                  disabled={busy || !input}
                >
                  Continue
                </button>
              </form>
            )
          ) : null}
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => {
              if (attempt.status === "pending") void cancel();
              else {
                if (attempt.status === "completed") setView({ kind: "saved" });
                update(null);
              }
            }}
          >
            {attempt.status === "pending" ? "Cancel login" : "Dismiss"}
          </button>
        </div>
      ) : null}
      {!attempt && !discovering ? (
        <>
          {saved.length ? (
            <section
              className="models-auth__saved"
              aria-label="Connected providers"
            >
              {saved.map((provider) => providerRow(provider))}
            </section>
          ) : (
            <p className="models-auth__empty">No connected providers.</p>
          )}
          <button
            type="button"
            className="models-text-button models-auth__connect"
            disabled={busy}
            onClick={() => {
              setRemoving(null);
              setView({ kind: "connect" });
            }}
          >
            <Plus size={14} aria-hidden /> Connect provider
          </button>
        </>
      ) : null}
      {!attempt && discovering ? (
        <section
          id={directoryId}
          className="models-auth__directory"
          aria-label="Available providers"
        >
          {selected ? (
            <div className="models-auth__drilldown">
              <button
                ref={backRef}
                type="button"
                className="models-text-button models-auth__back"
                onClick={() => setView({ kind: "connect" })}
              >
                <ArrowLeft size={14} aria-hidden /> Back to providers
              </button>
              {(() => {
                const target = providers.find((item) => item.id === selected);
                return target ? providerRow(target, true) : null;
              })()}
            </div>
          ) : (
            <>
              <button
                type="button"
                className="models-text-button models-auth__back"
                onClick={() => setView({ kind: "saved" })}
              >
                <ArrowLeft size={14} aria-hidden /> Back to connected providers
              </button>
              <label className="models-search">
                <input
                  ref={searchRef}
                  aria-label="Search providers"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search providers…"
                />
              </label>
              {loaded ? (
                <>
                  {available.length ? (
                    <div className="models-auth__providers">
                      {available.map((provider) => providerRow(provider))}
                    </div>
                  ) : null}
                  {!available.length ? (
                    <p className="settings__field-help">
                      {query.trim()
                        ? `No available providers matching "${query.trim()}"`
                        : "No providers available"}
                    </p>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
