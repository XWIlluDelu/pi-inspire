import type {
  ThinkingPresentationRuleDeclaration,
  ToolPresentationConfiguration,
} from "../../shared/tool-presentation-config";
import {
  compileThinkingPresentationRule,
  compileToolPresentationRules,
} from "./declarative";
import type {
  ResolvedToolPresentation,
  ToolPresentation,
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

interface ThinkingPresentationRegistry {
  resolve: (text: string) => ToolPresentation | null;
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

export function createThinkingPresentationRegistry(
  declaration?: ThinkingPresentationRuleDeclaration,
): ThinkingPresentationRegistry {
  const present = declaration
    ? compileThinkingPresentationRule(declaration)
    : undefined;
  return {
    resolve(text) {
      if (!present) return null;
      try {
        return present(text);
      } catch {
        return null;
      }
    },
  };
}

export let toolPresentationRegistry = createToolPresentationRegistry();
export let thinkingPresentationRegistry = createThinkingPresentationRegistry();

/** Replace the user-owned generation after an authoritative host bootstrap.
 * Existing shells and shipped definitions stay immutable; user declarations
 * replace only the projected summary and expanded body. */
export function configureToolPresentationRegistry(
  configuration?: ToolPresentationConfiguration,
): void {
  const resolved: ToolPresentationConfiguration = configuration ?? {
    version: 1,
    rules: {},
    mappings: {},
  };
  toolPresentationRegistry = createToolPresentationRegistry({
    userRules: compileToolPresentationRules(resolved),
    userMappings: resolved.mappings,
  });
  thinkingPresentationRegistry = createThinkingPresentationRegistry(
    resolved.thinking,
  );
}
