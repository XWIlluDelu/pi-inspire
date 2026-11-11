import { Check, Layers, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { shallowEqual, store, useAppState } from "../store";
import { availableUpdates, updateDetailsText } from "../update-availability";
import { useCopied } from "../use-copied";
import { CopyAction } from "./CopyAction";
import { PiLoader } from "./PiLoader";
import { SettingsSection } from "./SettingsSection";

const checkLabels = {
  initial: "Check updates",
  checking: "Checking…",
  checked: "Check again",
};

function UpdateCommand({ command }: { command: string }) {
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopied({ onError: setError });
  return (
    <>
      <button
        type="button"
        className={`file-path-action${copied ? " file-path-action--copied" : ""}`}
        aria-label={`Copy ${command}`}
        title={copied ? "Copied" : "Click to copy"}
        onClick={() => {
          setError(null);
          void copy(command);
        }}
      >
        <code className="file-path-action__text">{command}</code>
        {copied ? (
          <Check size={11} className="file-path-action__check" aria-hidden />
        ) : null}
        <span className="visually-hidden" aria-live="polite">
          {copied ? "Copied" : ""}
        </span>
      </button>
      {error ? (
        <span className="system-versions__error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

function VersionRow({
  label,
  links,
  children,
}: {
  label: string;
  links?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="system-versions__row">
      <dt className="system-versions__label">
        <span>{label}</span>
        {links}
      </dt>
      <dd className="system-versions__details">{children}</dd>
    </div>
  );
}

function VersionValue({
  version,
  versionTitle,
  restartRequired = false,
  status,
  update,
  command,
}: {
  version: string | null;
  versionTitle?: string;
  restartRequired?: boolean;
  status: string;
  update?: { version: string; url: string };
  command?: string;
}) {
  return (
    <div className="system-versions__value">
      <span className="system-versions__version" title={versionTitle}>
        {version ? `v${version}` : "Version unavailable"}
      </span>
      <span aria-hidden>·</span>
      {update ? (
        <a href={update.url} target="_blank" rel="noreferrer noopener">
          v{update.version} available ↗
        </a>
      ) : null}
      {update && command ? <UpdateCommand command={command} /> : null}
      {restartRequired || !update ? (
        <span>{restartRequired ? "Restart Host to apply" : status}</span>
      ) : null}
    </div>
  );
}

export function SystemVersionsCard() {
  const [copyError, setCopyError] = useState<string | null>(null);
  const state = useAppState(
    (source) => ({
      piUpdateCheck: source.piUpdateCheck,
      piUpdateChecking: source.piUpdateChecking,
      piUpdateRequestPending: source.piUpdateRequestPending,
      piUpdateRequestError: source.piUpdateRequestError,
      piVersion: source.piVersion,
      inspireUpdateCheck: source.inspireUpdateCheck,
      inspireUpdateChecking: source.inspireUpdateChecking,
      inspireUpdateRequestPending: source.inspireUpdateRequestPending,
      inspireUpdateRequestError: source.inspireUpdateRequestError,
      version: source.version,
    }),
    shallowEqual,
  );
  const updates = availableUpdates(state);
  const details = updates ? updateDetailsText(updates) : null;
  const piCheck = state.piUpdateCheck;
  const installedPiVersion = piCheck
    ? piCheck.installedVersion
    : state.piVersion;
  const piRestartRequired =
    Boolean(installedPiVersion) &&
    Boolean(piCheck) &&
    installedPiVersion !== piCheck?.currentVersion;
  const pi = piCheck?.pi;
  const extensions = state.piUpdateCheck?.extensions;
  const inspire = state.inspireUpdateCheck;
  const checking =
    state.piUpdateChecking ||
    state.inspireUpdateChecking ||
    state.piUpdateRequestPending ||
    state.inspireUpdateRequestPending;
  const checkError =
    state.piUpdateRequestError && state.inspireUpdateRequestError
      ? "Couldn't check for updates."
      : state.piUpdateRequestError || state.inspireUpdateRequestError;
  const hasPreviousResult = Boolean(
    (state.piUpdateRequestError && piCheck) ||
      (state.inspireUpdateRequestError && inspire),
  );
  const bothChecked = state.piUpdateCheck !== null && inspire !== null;
  const checkState = checking
    ? "checking"
    : bothChecked
      ? "checked"
      : "initial";

  return (
    <SettingsSection
      id="updates"
      icon={<Layers size={14} />}
      title="Versions"
      headerAction={
        <div
          className="system-versions__actions"
          onClickCapture={() => setCopyError(null)}
        >
          {details ? (
            <CopyAction
              key={details}
              text={details}
              label="Update details"
              className="system-versions__copy"
              onError={setCopyError}
            />
          ) : null}
          <button
            type="button"
            className="button system-versions__check"
            aria-label="Check for updates"
            aria-describedby={checkError ? "update-check-error" : undefined}
            disabled={checking}
            aria-busy={checking}
            onClick={() => {
              void store.checkPiUpdate();
              void store.checkInspireUpdate();
            }}
          >
            <span className="system-versions__check-content">
              {checking ? (
                <PiLoader size={13} aria-hidden />
              ) : (
                <RefreshCw size={13} aria-hidden />
              )}
              <span className="system-versions__check-label">
                {checkLabels[checkState]}
              </span>
            </span>
            {Object.values(checkLabels).map((label) => (
              <span
                key={label}
                className="system-versions__check-reserve"
                aria-hidden
              >
                {label}
              </span>
            ))}
          </button>
        </div>
      }
    >
      {checkError ? (
        <p
          id="update-check-error"
          className="settings__error system-versions__error"
          role="alert"
        >
          {checkError}
          {hasPreviousResult ? " Showing previous results." : null}
        </p>
      ) : null}
      {copyError ? (
        <p className="settings__error system-versions__error" role="alert">
          {copyError}
        </p>
      ) : null}
      <dl className="system-versions__list">
        <VersionRow
          label="Pi"
          links={
            <span className="system-versions__references">
              <a
                href="https://github.com/earendil-works/pi"
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Pi docs"
              >
                Docs
              </a>
              <a
                href="https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md"
                target="_blank"
                rel="noreferrer noopener"
              >
                Changelog
              </a>
            </span>
          }
        >
          <VersionValue
            version={installedPiVersion}
            versionTitle={
              piRestartRequired
                ? `The Host is running Pi v${piCheck?.currentVersion}.`
                : undefined
            }
            restartRequired={piRestartRequired}
            status={
              pi?.kind === "current"
                ? "Up to date"
                : pi?.kind === "unavailable"
                  ? "Check unavailable"
                  : "Not checked"
            }
            update={
              pi?.kind === "available"
                ? { version: pi.latestVersion, url: pi.releaseUrl }
                : undefined
            }
            command="pi update"
          />
        </VersionRow>

        <VersionRow label="Extensions">
          <div className="system-versions__value">
            {extensions?.kind === "available" ? (
              <>
                <span>
                  {extensions.updates.length} package{" "}
                  {extensions.updates.length === 1 ? "update" : "updates"}
                </span>
                <UpdateCommand command="pi update --extensions" />
              </>
            ) : (
              <span>
                {extensions?.kind === "none"
                  ? "No updates"
                  : extensions?.kind === "unavailable"
                    ? "Check unavailable"
                    : "Not checked"}
              </span>
            )}
          </div>
          {extensions?.kind === "available" ? (
            <ul
              className="system-versions__packages"
              aria-label="Packages with updates"
            >
              {extensions.updates.map(({ displayName, type }) => (
                <li key={`${type}:${displayName}`}>
                  <a
                    href={
                      type === "npm"
                        ? `https://www.npmjs.com/package/${displayName}`
                        : `https://${displayName}`
                    }
                    target="_blank"
                    rel="noreferrer noopener"
                    title={
                      type === "npm" ? "Open npm package" : "Open repository"
                    }
                  >
                    {displayName}
                    <span aria-hidden>&nbsp;↗</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </VersionRow>

        <VersionRow label="INSΠRE">
          <VersionValue
            version={state.version}
            status={
              inspire?.kind === "current"
                ? "Up to date"
                : inspire?.kind === "unreleased"
                  ? "No release published"
                  : inspire?.kind === "unavailable"
                    ? "Check unavailable"
                    : "Not checked"
            }
            update={
              inspire?.kind === "available"
                ? {
                    version: inspire.update.latestVersion,
                    url: inspire.update.releaseUrl,
                  }
                : undefined
            }
          />
        </VersionRow>
      </dl>
    </SettingsSection>
  );
}
