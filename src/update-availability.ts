import type {
  AvailableUpdate,
  PiExtensionUpdate,
  PiUpdateCheckResponse,
  UpdateCheckResponse,
} from "../shared/contracts";

export function updateDetailsText(updates: AvailableUpdates): string {
  const lines: string[] = [];
  if (updates.pi) {
    lines.push(
      `Pi ${updates.pi.currentVersion} → ${updates.pi.latestVersion}`,
      "Run pi update",
      updates.pi.releaseUrl,
    );
  }
  if (updates.extensions.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      "Extensions",
      ...updates.extensions.map((update) => `- ${update.displayName}`),
      "Run pi update --extensions",
    );
  }
  if (updates.inspire) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `INSΠRE ${updates.inspire.currentVersion} → ${updates.inspire.latestVersion}`,
      updates.inspire.releaseUrl,
    );
  }
  return lines.join("\n");
}

interface UpdateAvailabilityState {
  inspireUpdateCheck: UpdateCheckResponse | null;
  piUpdateCheck: PiUpdateCheckResponse | null;
}

export interface AvailablePiUpdate {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}

export interface AvailableUpdates {
  inspire: AvailableUpdate | null;
  pi: AvailablePiUpdate | null;
  extensions: PiExtensionUpdate[];
}

/** Browser presentation only; update identity and snoozing belong to the Host. */
export function availableUpdates(
  state: UpdateAvailabilityState,
): AvailableUpdates | null {
  const inspire =
    state.inspireUpdateCheck?.kind === "available"
      ? state.inspireUpdateCheck.update
      : null;
  const piCheck = state.piUpdateCheck;
  const piStatus = piCheck?.pi;
  const pi: AvailablePiUpdate | null =
    piCheck && piStatus?.kind === "available"
      ? {
          currentVersion: piCheck.currentVersion,
          latestVersion: piStatus.latestVersion,
          releaseUrl: piStatus.releaseUrl,
        }
      : null;
  const extensionStatus = state.piUpdateCheck?.extensions;
  const extensions =
    extensionStatus?.kind === "available"
      ? [...extensionStatus.updates].sort((left, right) =>
          left.displayName.localeCompare(right.displayName),
        )
      : [];
  if (!inspire && !pi && extensions.length === 0) return null;

  return {
    inspire,
    pi,
    extensions,
  };
}
