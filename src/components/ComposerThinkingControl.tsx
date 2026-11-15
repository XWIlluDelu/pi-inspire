import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import type { PiCommand } from "../../shared/commands";
import type { ThinkingLevel } from "../../shared/contracts";
import { thinkingLevelOptions } from "../model-options";
import {
  availableStatusControls,
  usePresentationAdapters,
} from "../presentation-adapters";
import { shallowEqual, useAppState } from "../store";
import { ChoicePanel } from "./ChoicePanel";
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
  const [open, setOpen] = useState(false);
  return (
    <div className="composer-thinking-control">
      <Dropdown
        {...props}
        direction="up"
        openRequest={openRequest}
        onOpenRequestHandled={onOpenRequestHandled}
        className="thinking-select"
        disabled={props.disabled || !thinkingSupported}
        options={thinkingLevelOptions(levels)}
      />
      {controls.length > 0 && (
        <ChoicePanel
          label="Extension controls"
          open={open}
          setOpen={setOpen}
          trigger={controls
            .map((control) => (
              <StatusChoiceIndicator
                key={control.id}
                control={control}
                {...(scope.kind === "session"
                  ? { status: scope.statuses[control.state.key] }
                  : { draftValue: scope.values[control.id] ?? null })}
              />
            ))
            .concat(<SlidersHorizontal key="settings" size={14} aria-hidden />)}
        >
          {controls.map((control) => (
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
                      onSelect: (value: string) =>
                        scope.onSelect(control.id, value),
                    },
                  })}
            />
          ))}
        </ChoicePanel>
      )}
    </div>
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
