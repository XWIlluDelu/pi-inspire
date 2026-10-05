import type { ReactNode } from "react";

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
  title: string;
  description?: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id ? `settings-section-${id}` : undefined}
      className="settings__section"
      aria-label={title}
    >
      <div className="settings__section-header">
        <div className="settings__section-title-wrap">
          <span className="settings__section-icon" aria-hidden>
            {icon}
          </span>
          <h3 className="settings__section-title">{title}</h3>
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
