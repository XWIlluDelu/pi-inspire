import type { PalettePreference } from "../shared/contracts";

export const PALETTE_LABELS: Record<PalettePreference, string> = {
  wisteria: "Wisteria",
  hydrangea: "Hydrangea",
  lycoris: "Lycoris",
  chimonanthus: "Chimonanthus",
  "classic-jade": "Jade",
  "classic-amber": "Amber",
  mono: "Carbon & Silicon",
};

export function preferenceChoiceLabel(value: string): string {
  if (value === "dynamic") return "Adaptive";
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
