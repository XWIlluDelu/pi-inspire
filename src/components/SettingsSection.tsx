import { type ReactNode, useId } from "react";
import { PiLoader } from "./PiLoader";

/** Card-level empty or error content uses the same inset as setting rows. */
export function SettingsCardMessage({
  children,
  error = false,
  loading = false,
  retry,
}: {
  children: ReactNode;
  error?: boolean;
  loading?: boolean;
  retry?: { run: () => void; label?: string; disabled?: boolean };
}) {
  return (
    <div className={`settings__card-message${error ? " settings__error" : ""}`}>
      {children && (
        <span
          className={loading ? "settings__card-loading" : undefined}
          role={error ? "alert" : loading ? "status" : undefined}
        >
          {loading ? <PiLoader size={13} aria-hidden /> : null}
          {children}
        </span>
      )}
      {retry && (
        <button
          type="button"
          className="button button--quiet"
          onClick={retry.run}
          disabled={retry.disabled}
        >
          {retry.label ?? "Retry"}
        </button>
      )}
    </div>
  );
}

export function SettingsSection({
  id,
  icon,
  title,
  description,
  headerAction,
  children,
}: {
  id?: string;
  icon: ReactNode;
  title: ReactNode;
  description?: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      id={id ? `settings-section-${id}` : undefined}
      className="settings__section"
      aria-labelledby={headingId}
    >
      <div className="settings__section-header">
        <div className="settings__section-heading">
          <div className="settings__section-title-wrap">
            <span className="settings__section-icon" aria-hidden>
              {icon}
            </span>
            <h3 id={headingId} className="settings__section-title">
              {title}
            </h3>
          </div>
          {headerAction && (
            <div className="settings__section-action">{headerAction}</div>
          )}
        </div>
        {description ? (
          <p className="settings__section-desc">{description}</p>
        ) : null}
      </div>
      <div className="settings__card">{children}</div>
    </section>
  );
}
