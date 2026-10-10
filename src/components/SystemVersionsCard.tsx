import { Check, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { shallowEqual, store, useAppState } from "../store";
import { useCopied } from "../use-copied";
import { SettingsSection } from "./SettingsSection";

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
  activity,
  status,
  update,
  command,
}: {
  version: string;
  activity: string | null;
  status: string;
  update?: { version: string; url: string };
  command?: string;
}) {
  return (
    <div className="system-versions__value">
      <span className="system-versions__version">
        {version ? `v${version}` : "Version unavailable"}
      </span>
      <span aria-hidden>·</span>
      {!activity && update ? (
        <>
          <a href={update.url} target="_blank" rel="noreferrer noopener">
            v{update.version} available ↗
          </a>
          {command ? <UpdateCommand command={command} /> : null}
        </>
      ) : (
        <span>{activity || status}</span>
      )}
    </div>
  );
}

export function SystemVersionsCard() {
  const state = useAppState(
    (source) => ({
      piUpdateCheck: source.piUpdateCheck,
      piUpdateChecking: source.piUpdateChecking,
      piUpdateRequestPending: source.piUpdateRequestPending,
      piVersion: source.piVersion,
      inspireUpdateCheck: source.inspireUpdateCheck,
      inspireUpdateChecking: source.inspireUpdateChecking,
      inspireUpdateRequestPending: source.inspireUpdateRequestPending,
      version: source.version,
    }),
    shallowEqual,
  );
  const pi = state.piUpdateCheck?.pi;
  const extensions = state.piUpdateCheck?.extensions;
  const inspire = state.inspireUpdateCheck;
  const pending =
    state.piUpdateRequestPending || state.inspireUpdateRequestPending;
  const checking = state.piUpdateChecking || state.inspireUpdateChecking;
  const bothChecked = state.piUpdateCheck !== null && inspire !== null;
  const piActivity = state.piUpdateRequestPending
    ? "Submitting…"
    : state.piUpdateChecking
      ? "Checking…"
      : null;
  const inspireActivity = state.inspireUpdateRequestPending
    ? "Submitting…"
    : state.inspireUpdateChecking
      ? "Checking…"
      : null;

  return (
    <SettingsSection
      id="updates"
      icon={<RefreshCw size={14} />}
      title="Versions"
      headerAction={
        <button
          type="button"
          className="button system-versions__check"
          aria-label="Check for updates"
          disabled={pending || checking}
          onClick={() => {
            void store.checkPiUpdate();
            void store.checkInspireUpdate();
          }}
        >
          <RefreshCw
            size={13}
            className={pending || checking ? "spin" : undefined}
            aria-hidden
          />
          {pending
            ? "Submitting…"
            : checking
              ? "Checking…"
              : bothChecked
                ? "Check again"
                : "Check for updates"}
        </button>
      }
    >
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
            version={state.piUpdateCheck?.currentVersion || state.piVersion}
            activity={piActivity}
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
            {piActivity ? (
              <span>{piActivity}</span>
            ) : extensions?.kind === "available" ? (
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
          {!piActivity && extensions?.kind === "available" ? (
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
            activity={inspireActivity}
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
