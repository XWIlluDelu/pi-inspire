import type {
  AvailableUpdate,
  PiExtensionUpdate,
  HostUpdateStatus,
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

export interface AvailableUpdates {
  inspire: AvailableUpdate | null;
  pi: AvailableUpdate | null;
  extensions: PiExtensionUpdate[];
}

/** Browser presentation only; update identity and snoozing belong to the Host. */
export function availableUpdates(
  state: Pick<HostUpdateStatus, "inspireUpdateCheck" | "piUpdateCheck">,
): AvailableUpdates | null {
  const inspire =
    state.inspireUpdateCheck?.kind === "available"
      ? state.inspireUpdateCheck.update
      : null;
  const piCheck = state.piUpdateCheck;
  const piStatus = piCheck?.pi;
  const pi =
    piCheck?.installedVersion && piStatus?.kind === "available"
      ? {
          currentVersion: piCheck.installedVersion,
          latestVersion: piStatus.latestVersion,
          releaseUrl: piStatus.releaseUrl,
        }
      : null;
  const extensionStatus = piCheck?.extensions;
  const extensions =
    extensionStatus?.kind === "available" ? extensionStatus.updates : [];
  if (!inspire && !pi && extensions.length === 0) return null;

  return {
    inspire,
    pi,
    extensions,
  };
}
