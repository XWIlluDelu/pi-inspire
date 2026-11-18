import { ArrowLeft, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import type {
  ProviderLoginAttempt,
  ProviderLoginOption,
} from "../../shared/model-settings";
import type { ProviderAuthOperation } from "../../shared/provider-auth-bridge";
import { isTransientFailure } from "../recovery-backoff";
import { store } from "../store";
import { ConfigurationConfirmation } from "./ConfigurationForm";
import { PromptChoices, PromptInput } from "./PromptFields";
import { SearchField } from "./SearchField";
import { SearchMatchText, searchMatchRanges } from "./SearchMatchText";
import { SettingsCardMessage } from "./SettingsSection";

type Owner = { sessionId?: string; cwd?: string };
type ProviderView = { kind: "saved" | "connect"; provider?: string };
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The Host could not complete this operation";

function matchesProvider(
  provider: ProviderLoginOption,
  query: string,
): boolean {
  return `${provider.id} ${provider.name}`.toLowerCase().includes(query);
}

function RemoteLoginHelp({ instruction }: { instruction: string }) {
  return (
    <details className="models-remote">
      <summary>Remote login</summary>
      <p>{instruction}</p>
    </details>
  );
}

type AuthenticationProps = {
  owner: Owner;
  providers: ProviderLoginOption[];
  onRefresh: () => Promise<ProviderLoginOption[] | void>;
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
  owner: initialOwner,
  providers,
  onRefresh,
  initialQuery = "",
  discover = false,
  loadError,
  loading = false,
  loaded = true,
}: AuthenticationProps) {
  const [owner] = useState(initialOwner);
  const [query, setQuery] = useState(initialQuery);
  const [view, setView] = useState<ProviderView>({
    kind: discover || initialQuery ? "connect" : "saved",
  });
  const discovering = view.kind === "connect";
  const [attempt, setAttempt] = useState<ProviderLoginAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const targetQuery = initialQuery.trim().toLowerCase();
  const targetMatches = targetQuery
    ? providers.filter((provider) => matchesProvider(provider, targetQuery))
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
  const writing = useRef(false);
  const mutationRevision = useRef(0);
  const attemptRef = useRef<ProviderLoginAttempt | null>(null);
  const ownsPendingAttempt = useCallback(
    (id: string) =>
      mounted.current &&
      attemptRef.current?.id === id &&
      attemptRef.current.status === "pending",
    [],
  );
  const update = useCallback((next: ProviderLoginAttempt | null) => {
    attemptRef.current = next;
    if (next?.status !== "pending") setError(null);
    setAttempt(next);
  }, []);
  const attemptId = attempt?.id;
  const attemptStatus = attempt?.status;
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
    if (!attemptId || attemptStatus !== "pending") return;
    let observing = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const revision = mutationRevision.current;
      try {
        const next = (await store.providerAuth(owner, {
          operation: "status",
          id: attemptId,
        })) as ProviderLoginAttempt;
        if (!observing || !ownsPendingAttempt(attemptId)) return;
        // A pending read started before a prompt mutation must not restore its
        // old prompt. Terminal receipts are authoritative and always settle it.
        if (
          next.status !== "pending" ||
          mutationRevision.current === revision
        ) update(next);
      } catch (error) {
        if (!observing || !ownsPendingAttempt(attemptId)) return;
        if (!isTransientFailure(error)) {
          update(null);
          setError(messageOf(error));
        }
      }
      if (observing && ownsPendingAttempt(attemptId))
        timer = setTimeout(() => void poll(), 750);
    };
    timer = setTimeout(() => void poll(), 250);
    return () => {
      observing = false;
      clearTimeout(timer);
    };
  }, [attemptId, attemptStatus, owner, update, ownsPendingAttempt]);
  const refreshAfterLogin = useEffectEvent(() => {
    void onRefresh().catch((error) => {
      if (mounted.current) setError(messageOf(error));
    });
  });
  useEffect(() => {
    if (attemptStatus === "completed" || attemptStatus === "failed")
      refreshAfterLogin();
  }, [attemptId, attemptStatus]);
  const mutate = async (
    request: Exclude<
      ProviderAuthOperation,
      { operation: "providers" | "status" }
    >,
  ) => {
    if (writing.current) return;
    writing.current = true;
    ++mutationRevision.current;
    const owns = () =>
      mounted.current &&
      (!("id" in request) || ownsPendingAttempt(request.id)) &&
      (request.operation !== "answer" ||
        !attemptRef.current?.prompt ||
        attemptRef.current.prompt.id === request.promptId);
    setBusy(true);
    setError(null);
    try {
      if (request.operation === "logout") {
        const removed = await store.providerAuth(owner, request).then(
          () => true, () => false,
        );
        if (!owns()) return;
        const current = await onRefresh();
        if (!owns()) return;
        if (!removed && (!current || current.some(
          (provider) => provider.id === request.provider && provider.stored,
        ))) throw new Error("Couldn’t remove the saved credentials.");
        setRemoving(null);
        setView({ kind: "saved" });
      } else {
        const next = (await store.providerAuth(owner, request)) as ProviderLoginAttempt | null;
        if (owns()) update(next);
        else if (request.operation === "start" && next?.status === "pending")
          void store
            .providerAuth(owner, { operation: "cancel", id: next.id })
            .catch(() => {});
      }
    } catch (error) {
      if (owns()) setError(messageOf(error));
    } finally {
      ++mutationRevision.current;
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const answer = (value: string) => {
    if (attempt?.prompt)
      void mutate({
        operation: "answer",
        id: attempt.id,
        promptId: attempt.prompt.id,
        value,
      });
  };
  const listed = providers.filter(
    (provider) =>
      Boolean(provider.stored) !== discovering &&
      (!discovering || matchesProvider(provider, query.trim().toLowerCase())),
  );
  const detail = providers.find((provider) => provider.id === view.provider);
  const shownDetail =
    detail && Boolean(detail.stored) !== discovering ? detail : undefined;
  useEffect(() => {
    if (!discovering || attempt) return;
    const search = searchRef.current;
    const section = search?.closest(".settings__section");
    search?.focus({ preventScroll: Boolean(section) });
    if (section && document.activeElement === search)
      section.scrollIntoView({ block: "start", behavior: "instant" });
  }, [discovering, attempt]);
  const providerDetail = shownDetail && (
    <div className="models-provider-login__details">
      {shownDetail.methods.map((method) => (
        <div className="models-login__method" key={method.type}>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() =>
              void mutate({
                operation: "start",
                provider: shownDetail.id,
                type: method.type,
              })
            }
          >
            {method.label}
          </button>
          {method.remoteHelp && (
            <RemoteLoginHelp instruction={method.remoteHelp} />
          )}
        </div>
      ))}
      {shownDetail.stored &&
        (removing === shownDetail.id ? (
          <ConfigurationConfirmation
            label="Remove saved credential"
            confirmLabel="Remove saved credentials"
            confirmDisabled={busy}
            onConfirm={() =>
              void mutate({ operation: "logout", provider: shownDetail.id })
            }
            onCancel={() => setRemoving(null)}
          >
            Remove the saved{" "}
            {shownDetail.stored === "api_key" ? "API key" : "login"} for{" "}
            {shownDetail.name}?
          </ConfigurationConfirmation>
        ) : (
          <button
            type="button"
            className="button button--danger-outline"
            disabled={busy}
            aria-label={`Remove saved credentials for ${shownDetail.name}`}
            onClick={() => setRemoving(shownDetail.id)}
          >
            Remove
          </button>
        ))}
    </div>
  );
  const providerList =
    listed.length > 0 ? (
      <section
        className="models-auth__providers"
        aria-label={discovering ? "Available providers" : "Connected providers"}
      >
        {listed.map((provider) => {
          const nameMatches = searchMatchRanges(provider.name, [query.trim()]);
          const idMatches =
            discovering && !nameMatches.length
              ? searchMatchRanges(provider.id, [query.trim()])
              : [];
          return (
            <div key={provider.id} className="models-provider-login">
              <div className="models-provider-login__heading">
                <div className="models-provider-login__copy">
              <SearchMatchText
                text={provider.name}
                ranges={discovering ? nameMatches : []}
              />
              {idMatches.length > 0 && (
                <code>
                  <SearchMatchText text={provider.id} ranges={idMatches} />
                </code>
              )}
              {provider.stored && (
                <small>
                  {provider.stored === "api_key"
                    ? "API key configured"
                    : "Signed in"}
                </small>
              )}
                </div>
                <button
              type="button"
              className="button models-provider-disclosure"
              aria-label={`${discovering ? "Set up" : "Manage"} ${provider.name}`}
              aria-expanded={view.provider === provider.id}
              disabled={busy}
              onClick={() => {
                setRemoving(null);
                setView({
                  kind: view.kind,
                  provider:
                    view.provider === provider.id ? undefined : provider.id,
                });
              }}
            >
                  {discovering ? "Set up" : "Manage"}
                </button>
              </div>
              {shownDetail?.id === provider.id && providerDetail}
            </div>
          );
        })}
      </section>
    ) : loaded && !loading && (!loadError || providers.length > 0) ? (
      <p className="models-auth__empty">
        {!discovering
          ? "No connected providers."
          : query.trim()
            ? `No available providers matching "${query.trim()}"`
            : "No providers available"}
      </p>
    ) : null;
  const latestEvent = attempt?.events.at(-1);
  const loginStatus =
    attempt?.status === "pending"
      ? (latestEvent?.type === "progress" && latestEvent.message) ||
        "Login in progress"
      : attempt?.message;
  return (
    <div className="models-auth" id="model-provider-credentials">
      {error ? <SettingsCardMessage error>{error}</SettingsCardMessage> : null}
      {loadError ? (
        <SettingsCardMessage
          error
          retry={{
            disabled: loading,
            run: () =>
              void onRefresh().catch((error) => setError(messageOf(error))),
          }}
        >
          {loaded ? "Provider refresh failed" : "Failed to load providers"}:{" "}
          {loadError}
        </SettingsCardMessage>
      ) : null}
      {loading && !loaded ? (
        <SettingsCardMessage loading>Loading providers…</SettingsCardMessage>
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
              {loginStatus}
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
          {attempt.prompt?.type === "select" ? (
            <PromptChoices
              key={attempt.prompt.id}
              label={attempt.prompt.message}
              pending={busy}
              onChoose={(value) => void answer(value)}
              options={(attempt.prompt.options ?? []).map((option) => ({
                value: option.id,
                label: option.label,
                details: (
                  <>
                    {option.remoteHelp && (
                      <RemoteLoginHelp instruction={option.remoteHelp} />
                    )}
                    {option.description && (
                      <p className="settings__field-help">
                        {option.description}
                      </p>
                    )}
                  </>
                ),
              }))}
            >
              <p>{attempt.prompt.message}</p>
            </PromptChoices>
          ) : attempt.prompt ? (
            <PromptInput
              key={attempt.prompt.id}
              title={attempt.prompt.message}
              kind={
                attempt.prompt.type === "secret" ||
                attempt.prompt.type === "manual_code"
                  ? "secret"
                  : "text"
              }
              placeholder={attempt.prompt.placeholder}
              pending={busy}
              required
              inlineLabel
              submitLabel="Continue"
              onSubmit={(value) => void answer(value)}
            />
          ) : null}
          <button
            type="button"
            className={`button${attempt.status === "pending" ? "" : " button--quiet"}`}
            disabled={busy}
            onClick={() => {
              if (attempt.status === "pending")
                void mutate({ operation: "cancel", id: attempt.id });
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
      {!attempt &&
        (discovering ? (
          <>
            <button
              type="button"
              className="models-text-button models-auth__back"
              onClick={() => setView({ kind: "saved" })}
            >
              <ArrowLeft size={14} aria-hidden />
              Back to connected providers
            </button>
            <SearchField
              inputRef={searchRef}
              aria-label="Search providers"
              value={query}
              onValueChange={setQuery}
              placeholder="Search providers…"
            />
            {providerList}
          </>
        ) : (
          <>
            {providerList}
            <button
              type="button"
              className="models-text-button models-auth__connect"
              disabled={
                busy ||
                !loaded ||
                loading ||
                Boolean(loadError && !providers.length)
              }
              onClick={() => {
                setRemoving(null);
                setView({ kind: "connect" });
              }}
            >
              <Plus size={14} aria-hidden /> Connect provider
            </button>
          </>
        ))}
    </div>
  );
}
