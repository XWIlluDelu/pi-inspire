import type { ComponentProps } from "react";
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

const THINKING_MENU_MIN_WIDTH = 208;

function ThinkingSelector({
  levels,
  display,
  menuWidth = THINKING_MENU_MIN_WIDTH,
  ...props
}: Omit<ComponentProps<typeof Dropdown>, "options" | "menuClassName"> & {
  levels: readonly ThinkingLevel[];
}) {
  return (
    <Dropdown
      {...props}
      menuClassName="thinking-selector__menu"
      display={display ?? thinkingLevelLabel(props.value)}
      options={thinkingLevelOptions(levels)}
      menuWidth={menuWidth}
    />
  );
}

type ThinkingControlProps = ComponentProps<typeof ThinkingSelector> & {
  thinkingSupported: boolean;
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
  ...props
}: ThinkingControlProps & { scope: ControlScope }) {
  const { configuration } = usePresentationAdapters();
  const controls = availableStatusControls(configuration, scope.commands);
  if (!controls.length)
    return (
      <ThinkingSelector
        {...props}
        disabled={props.disabled || !thinkingSupported}
      />
    );
  const width = Math.max(
    THINKING_MENU_MIN_WIDTH,
    ...controls.map(
      (control) =>
        20 +
        control.options.length *
          Math.max(...control.options.map((option) => option.label.length)) *
          6.5,
    ),
  );
  return (
    <ThinkingSelector
      {...props}
      className="composer-thinking-control"
      levels={thinkingSupported ? props.levels : []}
      title="Thinking level and extension controls"
      menuWidth={width}
      indicator={controls.map((control) => (
        <StatusChoiceIndicator
          key={control.id}
          control={control}
          {...(scope.kind === "session"
            ? { status: scope.statuses[control.state.key] }
            : { draftValue: scope.values[control.id] ?? null })}
        />
      ))}
      header={controls.map((control) => (
        <StatusChoice
          key={
            scope.kind === "session"
              ? scope.sessionId + ":" + scope.generation + ":" + control.id
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
                  onSelect: (value: string) =>
                    scope.onSelect(control.id, value),
                },
              })}
        />
      ))}
    />
  );
}

export function ComposerThinkingControl(props: ThinkingControlProps) {
  const scope = useAppState(
    (source) => ({
      kind: "session" as const,
      statuses: source.statuses,
      commands: source.commands,
      sessionId: source.sessionId,
      generation: source.transportGeneration,
    }),
    shallowEqual,
  );
  return <ThinkingControl {...props} scope={scope} />;
}
