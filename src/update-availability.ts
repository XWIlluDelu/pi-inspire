import type {
  AvailableUpdate,
  PiExtensionUpdate,
  PiUpdateCheckResponse,
  UpdateCheckResponse,
} from "../shared/contracts";

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

/** One stable identity and presentation projection for every available update. */
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
