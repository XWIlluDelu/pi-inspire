import type { InspirePreferences } from "../shared/contracts";

export function sessionCurationOwners(prefs: InspirePreferences) {
  return {
    ids: new Set([...prefs.pinnedSessionIds, ...prefs.hiddenSessionIds]),
    cwds: new Set([...prefs.pinnedProjectCwds, ...prefs.hiddenProjectCwds]),
  };
}
