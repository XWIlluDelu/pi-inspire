import type { InspirePreferences } from "../shared/contracts";

/** Keep confirmed rows reachable until the optimistic preference write settles. */
export function sessionCurationOwners(
  visible: InspirePreferences,
  confirmed: InspirePreferences,
) {
  return {
    ids: new Set([
      ...visible.pinnedSessionIds,
      ...visible.hiddenSessionIds,
      ...confirmed.pinnedSessionIds,
      ...confirmed.hiddenSessionIds,
    ]),
    cwds: new Set([
      ...visible.pinnedProjectCwds,
      ...visible.hiddenProjectCwds,
      ...confirmed.pinnedProjectCwds,
      ...confirmed.hiddenProjectCwds,
    ]),
  };
}
