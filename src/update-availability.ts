import type {
  AvailableUpdate,
  PiExtensionUpdate,
  PiUpdateCheckResponse,
} from "../shared/contracts";

interface UpdateAvailabilityState {
  availableUpdate: AvailableUpdate | null;
  piUpdateCheck: PiUpdateCheckResponse | null;
}

export interface AvailablePiUpdate {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}

export interface AvailableUpdates {
  identity: string;
  inspire: AvailableUpdate | null;
  pi: AvailablePiUpdate | null;
  extensions: PiExtensionUpdate[];
}

/** One stable identity and presentation projection for every available update. */
export function availableUpdates(
  state: UpdateAvailabilityState,
): AvailableUpdates | null {
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
  if (!state.availableUpdate && !pi && extensions.length === 0) return null;

  const identity = JSON.stringify([
    state.availableUpdate
      ? ["inspire", state.availableUpdate.latestVersion]
      : null,
    pi ? ["pi", pi.latestVersion] : null,
    ...extensions.map((update) => [
      "extension",
      update.type,
      update.displayName,
    ]),
  ]);
  return {
    identity,
    inspire: state.availableUpdate,
    pi,
    extensions,
  };
}
