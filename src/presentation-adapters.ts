import { useSyncExternalStore } from "react";
import type { PiCommand } from "../shared/commands";
import {
  emptyToolPresentationConfiguration,
  type PresentationAdapterInfo,
  type StatusControlDeclaration,
  type ToolPresentationConfiguration,
} from "../shared/tool-presentation-config";
import { resolveCommandInventory } from "./composer-completion";
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

/** Every entry point admits the same declared controls from its own command inventory. */
export function availableStatusControls(
  configuration: ToolPresentationConfiguration,
  commands: readonly PiCommand[],
): StatusControlDeclaration[] {
  const inventory = resolveCommandInventory(commands);
  return (
    configuration.controls?.filter((control) =>
      inventory.some(
        (command) =>
          command.source === "extension" &&
          "/" + command.name === control.command,
      ),
    ) ?? []
  );
}

function field(value: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
export function controlState(control: StatusControlDeclaration, text?: string) {
  try {
    const data: unknown = JSON.parse(text ?? "");
    const value = field(data, control.state.value);
    if (
      typeof value !== "string" ||
      !control.options.some((option) => option.value === value)
    )
      return null;
    const supported = control.state.supported
      ? field(data, control.state.supported)
      : undefined;
    const active = control.state.active
      ? field(data, control.state.active)
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
