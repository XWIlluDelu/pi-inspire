import { type ReactNode, useId } from "react";

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
        <div className="settings__section-title-wrap">
          <div className="settings__section-heading">
            <span className="settings__section-icon" aria-hidden>
              {icon}
            </span>
            <h3 id={headingId} className="settings__section-title">
              {title}
            </h3>
          </div>
          {headerAction ? (
            <div className="settings__section-action">{headerAction}</div>
          ) : null}
        </div>
        {description ? (
          <p className="settings__section-desc">{description}</p>
        ) : null}
      </div>
      <div className="settings__card">{children}</div>
    </section>
  );
}
