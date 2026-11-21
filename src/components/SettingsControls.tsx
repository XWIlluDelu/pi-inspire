import {
  type ComponentProps,
  type ReactNode,
  useLayoutEffect,
  useRef,
} from "react";
import { Dropdown } from "./Dropdown";
import { ToggleSwitch } from "./ToggleSwitch";

export function SettingsLayout<Category extends string>({
  label,
  categories,
  navigation,
  onNavigate,
  busy,
  children,
  footer,
}: {
  label: string;
  categories: readonly { id: Category; label: string; icon: ReactNode }[];
  navigation: { category: Category; section?: string };
  onNavigate: (category: Category) => void;
  busy?: boolean;
  children: ReactNode;
  footer: ReactNode;
}) {
  const content = useRef<HTMLElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const pane = content.current;
    const section =
      navigation.section && document.getElementById(navigation.section);
    if (pane)
      pane.scrollTo({
        top:
          section && pane.contains(section)
            ? pane.scrollTop +
              section.getBoundingClientRect().top -
              pane.getBoundingClientRect().top -
              Number.parseFloat(getComputedStyle(pane).paddingTop)
            : 0,
        behavior: "instant",
      });
    const nav = sidebar.current;
    const selected = nav?.querySelector<HTMLElement>(
      '[aria-current="location"]',
    );
    if (!nav || !selected) return;
    const reveal = () => revealSettingsCategory(selected);
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [navigation]);
  return (
    <div className="settings__layout" aria-busy={busy || undefined}>
      <nav className="settings__sidebar" aria-label={label} ref={sidebar}>
        <div className="settings__nav-list">
          {categories.map(({ id, label, icon }) => {
            const active = navigation.category === id;
            return (
              <button
                type="button"
                key={id}
                aria-current={active ? "location" : undefined}
                className={`settings__nav-item${active ? " settings__nav-item--active" : ""}`}
                onFocus={(event) => {
                  if (event.currentTarget.matches(":focus-visible"))
                    revealSettingsCategory(event.currentTarget);
                }}
                onClick={() => onNavigate(id)}
              >
                <span className="settings__nav-icon" aria-hidden>
                  {icon}
                </span>
                <span className="settings__nav-label">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
      <div className="settings__main">
        <main className="settings__content" ref={content}>
          {children}
        </main>
        {footer}
      </div>
    </div>
  );
}

function revealSettingsCategory(category: HTMLElement) {
  category.scrollIntoView({
    block: "nearest",
    inline: "nearest",
    behavior: "instant",
  });
}

export function SettingsPage({
  hidden,
  children,
}: {
  hidden: boolean;
  children: ReactNode;
}) {
  return (
    <div className="settings__page" hidden={hidden}>
      {children}
    </div>
  );
}

type FieldDetails = {
  id?: string;
  label: string;
  description?: ReactNode;
  status?: ReactNode;
  feedback?: ReactNode;
  className?: string;
  layout?: "adaptive" | "inline";
};

export function SettingField({
  id,
  label,
  description,
  children,
  status,
  feedback,
  className,
  layout = "adaptive",
}: FieldDetails & { children: ReactNode }) {
  return (
    <div
      id={id}
      className={`settings__field${className ? ` ${className}` : ""}`}
      data-layout={layout}
      data-detailed={Boolean(description || status) || undefined}
    >
      <div className="settings__field-info">
        <span className="settings__field-label">{label}</span>
        {description ? (
          <p className="settings__field-help">{description}</p>
        ) : null}
        {status ? <div className="settings__field-status">{status}</div> : null}
      </div>
      <div className="settings__field-control">{children}</div>
      {feedback && <div className="settings__field-feedback">{feedback}</div>}
    </div>
  );
}

/** Keep related feedback together without reserving empty progress rows. */
export function SettingsFeedback({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="settings__feedback" role="group" aria-label={label}>
      {children}
    </div>
  );
}

type ChoiceField = FieldDetails & { controlLabel?: string };

export function SelectField<Value extends string>({
  controlLabel,
  label,
  description,
  status,
  feedback,
  className,
  layout,
  ...select
}: ChoiceField &
  Omit<ComponentProps<typeof Dropdown<Value>>, "label" | "className">) {
  return (
    <SettingField
      {...{ label, description, status, feedback, className, layout }}
    >
      <Dropdown label={controlLabel ?? label} {...select} />
    </SettingField>
  );
}

export function SwitchField({
  controlLabel,
  label,
  description,
  status,
  ...control
}: Pick<FieldDetails, "label" | "description" | "status"> & {
  controlLabel?: string;
} & Omit<ComponentProps<typeof ToggleSwitch>, "label">) {
  return (
    <SettingField layout="inline" {...{ label, description, status }}>
      <ToggleSwitch label={controlLabel ?? label} {...control} />
    </SettingField>
  );
}
