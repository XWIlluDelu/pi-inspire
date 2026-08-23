export function preferenceChoiceLabel(value: string): string {
  if (value === "dynamic") return "Adaptive";
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
