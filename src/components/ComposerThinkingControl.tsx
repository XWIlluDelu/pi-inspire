import type { ComponentProps } from "react";
import type { ThinkingLevel } from "../../shared/contracts";
import { thinkingLevelLabel, thinkingLevelOptions } from "../model-options";
import { usePresentationAdapters } from "../presentation-adapters";
import { shallowEqual, useAppState } from "../store";
import { Dropdown } from "./Dropdown";
import { StatusChoice, StatusChoiceIndicator } from "./StatusChoice";

const THINKING_MENU_MIN_WIDTH = 208;

export function ThinkingSelector({
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

export function ComposerThinkingControl({
  thinkingSupported,
  ...props
}: ComponentProps<typeof ThinkingSelector> & { thinkingSupported: boolean }) {
  const { configuration } = usePresentationAdapters();
  const state = useAppState(
    (source) => ({
      statuses: source.statuses,
      commands: source.commands,
      sessionId: source.sessionId,
      generation: source.transportGeneration,
    }),
    shallowEqual,
  );
  const controls =
    configuration.controls?.filter(
      (control) =>
        control.slot === "thinking" &&
        state.commands.some(
          (command) =>
            command.source === "extension" &&
            "/" + command.name === control.command,
        ),
    ) ?? [];
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
          status={state.statuses[control.state.key]}
        />
      ))}
      header={controls.map((control) => (
        <StatusChoice
          key={state.sessionId + ":" + state.generation + ":" + control.id}
          control={control}
          status={state.statuses[control.state.key]}
          disabled={Boolean(props.disabled)}
          owner={state.sessionId}
          generation={state.generation}
        />
      ))}
    />
  );
}
