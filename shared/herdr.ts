/** Browser-safe observation of the optional Herdr enhancement on this Host.
 * `enabled` is the effective value captured at Host startup, not the saved
 * preference awaiting a restart. */
export interface HerdrEnhancementStatus {
  enabled: boolean;
  supported: boolean;
  installed: boolean;
  running: boolean;
  compatible: boolean | null;
  version: string | null;
  /** Plain-language, browser-safe reason for limited availability. */
  issue?: string;
}
