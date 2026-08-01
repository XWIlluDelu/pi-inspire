import type { ProfilerOnRenderCallback } from "react";

declare global {
  interface Window {
    __INSPIRE_MAINTENANCE_BENCHMARK__?: {
      commits: Array<{
        surface: string;
        phase: string;
        actualDuration: number;
        baseDuration: number;
        startTime: number;
        commitTime: number;
      }>;
    };
  }
}

/** Imported only by compile-time benchmark branches in App. Production builds
 * fold those branches away and Rollup removes this module and its global sink. */
export const recordBenchmarkCommit: ProfilerOnRenderCallback = (
  surface,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  const sink = window.__INSPIRE_MAINTENANCE_BENCHMARK__ ??= { commits: [] };
  sink.commits.push({ surface, phase, actualDuration, baseDuration, startTime, commitTime });
};
