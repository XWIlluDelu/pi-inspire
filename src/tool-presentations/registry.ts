import type {
  ResolvedToolPresentation,
  ToolPresentationInput,
  ToolPresentationMappings,
  ToolPresentationRule,
} from "./model";
import {
  PI_NATIVE_TOOL_PRESENTATION_MAPPINGS,
  PI_NATIVE_TOOL_PRESENTATION_RULES,
} from "./pi-native";

interface ToolPresentationRegistryOptions {
  builtInRules?: readonly ToolPresentationRule[];
  builtInMappings?: ToolPresentationMappings;
  userRules?: readonly ToolPresentationRule[];
  userMappings?: ToolPresentationMappings;
}

interface ToolPresentationRegistry {
  resolve: (input: ToolPresentationInput) => ResolvedToolPresentation | null;
}

/** Build one immutable lookup generation. User mappings replace name bindings;
 * they do not mutate or field-merge shipped rules. Once a mapping is selected,
 * a missing, failing, or incompatible rule falls directly through to generic
 * raw presentation rather than trying a second semantic interpretation. */
export function createToolPresentationRegistry({
  builtInRules = PI_NATIVE_TOOL_PRESENTATION_RULES,
  builtInMappings = PI_NATIVE_TOOL_PRESENTATION_MAPPINGS,
  userRules = [],
  userMappings = {},
}: ToolPresentationRegistryOptions = {}): ToolPresentationRegistry {
  const rules = new Map<string, ToolPresentationRule>();
  for (const rule of builtInRules) rules.set(rule.id, rule);
  // A user rule can replace a name binding, never the shipped rule definition
  // behind an INSΠRE-owned id.
  for (const rule of userRules) {
    if (!rules.has(rule.id)) rules.set(rule.id, rule);
  }
  const mappings = new Map<string, string>([
    ...Object.entries(builtInMappings),
    ...Object.entries(userMappings),
  ]);

  return {
    resolve(input) {
      const ruleId = mappings.get(input.call.name);
      if (!ruleId) return null;
      const rule = rules.get(ruleId);
      if (!rule) return null;
      try {
        const rendered = rule.present(input);
        return rendered ? { ...rendered, ruleId } : null;
      } catch {
        return null;
      }
    },
  };
}

export const toolPresentationRegistry = createToolPresentationRegistry();
