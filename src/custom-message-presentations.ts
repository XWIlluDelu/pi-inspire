import type {
  CustomMessagePresentationDeclaration,
  ToolPresentationConfiguration,
} from "../shared/tool-presentation-config";
import type { ChatMessage } from "./events";

interface CustomMessagePresentation {
  title: string;
  source: string;
  body: string;
}

function select(message: ChatMessage, path: string): unknown {
  let value: unknown = message;
  for (const key of path.split(".")) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** A reading projection only: original content and details remain owned by the
 * message. Non-string content keeps its generic image/unknown-block renderer. */
export function createCustomMessagePresentationRegistry(
  declarations: ToolPresentationConfiguration["customMessages"] = {},
) {
  const rules = new Map<string, CustomMessagePresentationDeclaration>(
    Object.entries(declarations),
  );
  return {
    resolve(message: ChatMessage): CustomMessagePresentation | null {
      if (typeof message.content !== "string" || !message.customType)
        return null;
      const rule = rules.get(message.customType);
      if (!rule) return null;
      // Require actual absence, not a falsey value, for trust/shape guards.
      if (
        rule.requireAbsent?.some((path) => select(message, path) !== undefined)
      )
        return null;
      const body = select(message, rule.body);
      if (typeof body !== "string") return null;
      for (const path of rule.title) {
        const title = select(message, path);
        if (title === undefined || title === null || title === "") continue;
        if (typeof title !== "string") return null;
        if (!title.trim()) continue;
        return { title, source: rule.source, body };
      }
      return null;
    },
  };
}
