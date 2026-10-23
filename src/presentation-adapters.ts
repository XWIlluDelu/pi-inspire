import { useSyncExternalStore } from "react";
import type { PiCommand } from "../shared/commands";
import {
  emptyToolPresentationConfiguration,
  type PresentationAdapterInfo,
  type StatusControlDeclaration,
  type ToolPresentationConfiguration,
} from "../shared/tool-presentation-config";
import { resolveCommandInventory } from "./composer-completion";
import type { ChatMessage } from "./events";

let current = {
  configuration: emptyToolPresentationConfiguration(),
  adapters: [] as PresentationAdapterInfo[],
};
const listeners = new Set<() => void>();
export function subscribePresentationAdapters(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function getPresentationAdapters() {
  return current;
}
export function usePresentationAdapters() {
  return useSyncExternalStore(
    subscribePresentationAdapters,
    getPresentationAdapters,
  );
}
export function configurePresentationAdapters(
  configuration: ToolPresentationConfiguration,
  adapters: PresentationAdapterInfo[] = [],
) {
  current = { configuration, adapters };
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

export function checkpointPresentation(message: ChatMessage) {
  const compacted = message.role === "compactionSummary";
  const summary = typeof message.summary === "string" ? message.summary : "";
  const declaration = compacted
    ? current.configuration.checkpoints?.find((rule) => {
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
