import type { z } from "zod";

export function nullableEdit<Schema extends z.ZodType>(schema: Schema) {
  return schema.nullable().optional();
}

export type ConfigurationControl = {
  label: string;
  type?: "number" | "password";
  placeholder?: string;
  wide?: boolean;
  min?: number;
  max?: number;
  step?: string;
  maxLength?: number;
  required?: boolean;
};

export function configurationField<Schema extends z.ZodType>(
  schema: Schema,
  control: ConfigurationControl,
) {
  return { schema: nullableEdit(schema), control };
}

export function storedConfigurationValue<
  Stored extends z.ZodType,
  Edited extends z.ZodType,
>(stored: Stored, edited: Edited) {
  return {
    schema: nullableEdit(edited),
    stored: stored.optional().catch(undefined),
  };
}

export function storedConfigurationField<Schema extends z.ZodType>(
  stored: Schema,
  control: ConfigurationControl,
  edited = stored,
) {
  return { ...storedConfigurationValue(stored, edited), control };
}

export function fieldSchemas<
  Key extends "schema" | "stored",
  Fields extends Record<string, Record<Key, z.ZodType>>,
>(fields: Fields, key: Key): { [Field in keyof Fields]: Fields[Field][Key] } {
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [name, field[key]]),
  ) as { [Field in keyof Fields]: Fields[Field][Key] };
}

/** Protected wire values encode keep as omission and remove as null. */
export type SecretEdit<Value extends string | number = string> =
  | { kind: "keep" }
  | { kind: "replace"; value: Value }
  | { kind: "remove" };

export function secretValue<Value extends string | number>(
  edit: SecretEdit<Value>,
): Value | null | undefined {
  if (edit.kind === "replace") return edit.value;
  return edit.kind === "remove" ? null : undefined;
}
