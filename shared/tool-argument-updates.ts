/** Host-authored, display-only argument updates. These never execute a tool. */
export type ToolArgumentPath = (string | number)[];
export type ToolArgumentUpdate =
  | { path: ToolArgumentPath; set: unknown }
  | { path: ToolArgumentPath; append: string };

export interface ToolCallPreview {
  phase: "streaming" | "interrupted";
  characters: number;
  truncated: boolean;
}

export const MAX_TOOL_ARGUMENT_PREVIEW_CHARS = 32_000;
export const MAX_TOOL_ARGUMENT_DEPTH = 8;
export const MAX_TOOL_ARGUMENT_NODES = 256;
export const MAX_TOOL_ARGUMENT_KEY_CHARS = 256;

function container(
  value: unknown,
): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

export function toolArgumentAt(
  value: unknown,
  path: ToolArgumentPath,
): unknown {
  let current = value;
  for (const key of path) {
    if (!container(current) || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function validPath(path: unknown): path is ToolArgumentPath {
  return (
    Array.isArray(path) &&
    path.length > 0 &&
    path.length <= MAX_TOOL_ARGUMENT_DEPTH &&
    path.every((key) =>
      typeof key === "string"
        ? key.length <= MAX_TOOL_ARGUMENT_KEY_CHARS
        : Number.isSafeInteger(key) &&
          key >= 0 &&
          key < MAX_TOOL_ARGUMENT_NODES,
    )
  );
}

function validSet(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" &&
      value.length <= MAX_TOOL_ARGUMENT_PREVIEW_CHARS) ||
    (container(value) && Object.keys(value).length === 0)
  );
}

/** Copy only the updated path; never mutate a prior render or follow prototypes. */
function replaceAt(
  value: unknown,
  path: ToolArgumentPath,
  replacement: unknown,
  index = 0,
): unknown | null {
  if (!container(value)) return null;
  const key = path[index]!;
  if (
    Array.isArray(value)
      ? typeof key !== "number" || key > value.length
      : typeof key !== "string"
  )
    return null;
  if (index < path.length - 1 && !Object.hasOwn(value, key)) return null;
  const child =
    index === path.length - 1
      ? replacement
      : replaceAt(
          (value as Record<string | number, unknown>)[key],
          path,
          replacement,
          index + 1,
        );
  if (index < path.length - 1 && child === null) return null;
  if (Array.isArray(value)) {
    const next = value.slice();
    next[key as number] = child;
    return next;
  }
  // Computed property initialization, unlike assignment, treats __proto__ as data.
  return { ...value, [key]: child };
}

export function applyToolArgumentUpdates(
  argumentsValue: unknown,
  updates: unknown,
): unknown | null {
  if (!Array.isArray(updates) || updates.length > MAX_TOOL_ARGUMENT_NODES * 4)
    return null;
  let next = argumentsValue;
  for (const candidate of updates) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !validPath(candidate.path)
    )
      return null;
    const update = candidate as ToolArgumentUpdate;
    let value: unknown;
    if ("append" in update) {
      const prefix = toolArgumentAt(next, update.path);
      if (
        typeof update.append !== "string" ||
        typeof prefix !== "string" ||
        prefix.length + update.append.length > MAX_TOOL_ARGUMENT_PREVIEW_CHARS
      )
        return null;
      value = prefix + update.append;
    } else if ("set" in update && validSet(update.set)) value = update.set;
    else return null;
    next = replaceAt(next, update.path, value);
    if (next === null) return null;
  }
  return next;
}
