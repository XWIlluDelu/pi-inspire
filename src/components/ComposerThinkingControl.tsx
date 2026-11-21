import type { PiCommand } from "../../shared/commands";
import type { ThinkingLevel } from "../../shared/contracts";
import { thinkingLevelLabel, thinkingLevelOptions } from "../model-options";
import {
  availableStatusControls,
  usePresentationAdapters,
} from "../presentation-adapters";
import { shallowEqual, useAppState } from "../store";
import { Dropdown } from "./Dropdown";
import { StatusChoice, StatusChoiceIndicator } from "./StatusChoice";

type ThinkingControlProps = {
  thinkingSupported: boolean;
  levels: readonly ThinkingLevel[];
  label: string;
  title?: string;
  value: string;
  display?: string;
  disabled?: boolean;
  openRequest?: number;
  onOpenRequestHandled?: (id: number) => void;
  onChange(value: ThinkingLevel): void;
};

type ControlScope = {
  commands: readonly PiCommand[];
} & (
  | {
      kind: "session";
      sessionId: string | null;
      generation: number;
      statuses: Record<string, string>;
    }
  | {
      kind: "new-session";
      values: Record<string, string>;
      onSelect: (id: string, value: string) => void;
    }
);

/** Lifecycle supplies state and execution; capability admission and presentation stay shared. */
export function ThinkingControl({
  scope,
  thinkingSupported,
  openRequest,
  onOpenRequestHandled,
  levels,
  ...props
}: ThinkingControlProps & { scope: ControlScope }) {
  const { configuration } = usePresentationAdapters();
  const controls = availableStatusControls(configuration, scope.commands);
  const width = Math.max(
    208,
    ...controls.map(
      (control) =>
        20 +
        control.options.length *
          Math.max(...control.options.map((option) => option.label.length)) *
          6.5,
    ),
  );
  return (
    <Dropdown
      {...props}
      // Without supported options the raw level would show; keep one label rule.
      display={
        props.display ??
        (props.value ? thinkingLevelLabel(props.value) : undefined)
      }
      direction="up"
      openRequest={openRequest}
      onOpenRequestHandled={onOpenRequestHandled}
      className="thinking-select"
      menuWidth={width}
      title={
        controls.length ? "Thinking level and extension controls" : props.title
      }
      disabled={props.disabled || (!thinkingSupported && !controls.length)}
      options={thinkingLevelOptions(thinkingSupported ? levels : [])}
      indicator={controls.map((control) => (
        <StatusChoiceIndicator
          key={control.id}
          control={control}
          {...(scope.kind === "session"
            ? { status: scope.statuses[control.state.key] }
            : { draftValue: scope.values[control.id] ?? null })}
        />
      ))}
      header={
        controls.length > 0
          ? controls.map((control) => (
              <StatusChoice
                key={
                  scope.kind === "session"
                    ? `${scope.sessionId}:${scope.generation}:${control.id}`
                    : control.id
                }
                control={control}
                disabled={Boolean(props.disabled)}
                {...(scope.kind === "session"
                  ? {
                      status: scope.statuses[control.state.key],
                      owner: scope.sessionId,
                      generation: scope.generation,
                    }
                  : {
                      draft: {
                        value: scope.values[control.id] ?? null,
                        onSelect: (value) => scope.onSelect(control.id, value),
                      },
                    })}
              />
            ))
          : undefined
      }
    />
  );
}

export function ComposerThinkingControl(props: ThinkingControlProps) {
  const scope = useAppState(
    (source) => ({
      kind: "session" as const,
      statuses: source.live.statuses,
      commands: source.commands,
      sessionId: source.sessionId,
      generation: source.transportGeneration,
    }),
    shallowEqual,
  );
  return <ThinkingControl {...props} scope={scope} />;
}
