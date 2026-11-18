import { useSyncExternalStore } from "react";
import { nativeCommand, type PiCommand } from "../shared/commands";
import { jsonValueAt } from "../shared/json-record";
import {
  emptyToolPresentationConfiguration,
  type PresentationAdapterInfo,
  type StatusControlDeclaration,
  type ToolPresentationConfiguration,
} from "../shared/tool-presentation-config";
import { createCustomMessagePresentationRegistry } from "./custom-message-presentations";
import type { ChatMessage } from "./events";
import { compileToolPresentationRules } from "./tool-presentations/declarative";
import {
  createThinkingPresentationRegistry,
  createToolPresentationRegistry,
} from "./tool-presentations/registry";

interface PresentationGeneration {
  readonly configuration: ToolPresentationConfiguration;
  readonly adapters: readonly PresentationAdapterInfo[];
  readonly tools: ReturnType<typeof createToolPresentationRegistry>;
  readonly thinking: ReturnType<typeof createThinkingPresentationRegistry>;
  readonly customMessages: ReturnType<
    typeof createCustomMessagePresentationRegistry
  >;
}

function compileGeneration(
  configuration = emptyToolPresentationConfiguration(),
  adapters: readonly PresentationAdapterInfo[] = [],
): PresentationGeneration {
  return Object.freeze({
    configuration,
    adapters,
    tools: createToolPresentationRegistry({
      userRules: compileToolPresentationRules(configuration),
      userMappings: configuration.mappings,
    }),
    thinking: createThinkingPresentationRegistry(configuration.thinking),
    customMessages: createCustomMessagePresentationRegistry(
      configuration.customMessages,
    ),
  });
}

let current = compileGeneration();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function presentationGeneration() {
  return current;
}

export function usePresentationAdapters() {
  return useSyncExternalStore(subscribe, presentationGeneration);
}

export function configurePresentationAdapters(
  configuration?: ToolPresentationConfiguration,
  adapters?: readonly PresentationAdapterInfo[],
) {
  current = compileGeneration(configuration, adapters);
  for (const listener of listeners) listener();
}

export function hasStatusControlCommand(
  control: StatusControlDeclaration,
  commands: readonly PiCommand[],
): boolean {
  const name = control.command.slice(1);
  return (
    !nativeCommand(name) &&
    commands.find((command) => command.name === name)?.source === "extension"
  );
}

export function availableStatusControls(
  configuration: ToolPresentationConfiguration,
  commands: readonly PiCommand[],
): StatusControlDeclaration[] {
  return (
    configuration.controls?.filter((control) =>
      hasStatusControlCommand(control, commands),
    ) ?? []
  );
}

export function controlState(control: StatusControlDeclaration, text?: string) {
  try {
    const data: unknown = JSON.parse(text ?? "");
    const value = jsonValueAt(data, control.state.value);
    if (
      typeof value !== "string" ||
      !control.options.some((option) => option.value === value)
    )
      return null;
    const supported = control.state.supported
      ? jsonValueAt(data, control.state.supported)
      : undefined;
    const active = control.state.active
      ? jsonValueAt(data, control.state.active)
      : undefined;
    if (control.state.active && typeof active !== "boolean") return null;
    if (
      control.state.supported &&
      (!supported ||
        typeof supported !== "object" ||
        !control.options.every(
          (option) =>
            typeof (supported as Record<string, unknown>)[option.value] ===
            "boolean",
        ))
    )
      return null;
    return {
      value,
      supported:
        supported && typeof supported === "object"
          ? (supported as Record<string, unknown>)
          : null,
      active: typeof active === "boolean" ? active : null,
    };
  } catch {
    return null;
  }
}

export function checkpointPresentation(
  message: ChatMessage,
  configuration: ToolPresentationConfiguration,
) {
  const compacted = message.role === "compactionSummary";
  const summary = typeof message.summary === "string" ? message.summary : "";
  const declaration = compacted
    ? configuration.checkpoints?.find((rule) => {
        if (message.__inspireCompactionSource)
          return message.__inspireCompactionSource === rule.source;
        const prefix = rule.legacySummaryPrefix;
        return (
          prefix &&
          summary.startsWith(prefix) &&
          (summary.length === prefix.length ||
            /^[\s:]/.test(summary.slice(prefix.length)))
        );
      })
    : undefined;
  return {
    compacted,
    summary,
    displaySummary:
      declaration?.summaryPrefix &&
      summary.startsWith(declaration.summaryPrefix)
        ? summary.slice(declaration.summaryPrefix.length).trimStart()
        : summary,
    title:
      declaration?.title ??
      (compacted ? "Context compacted" : "Branch context"),
    tokensLabel: declaration?.tokensLabel ?? "Before",
    tokensDescription:
      declaration?.tokensDescription ??
      "Estimated context size before compaction.",
  };
}
