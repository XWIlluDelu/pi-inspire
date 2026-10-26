import type { CompletionAttentionPreference } from "./contracts.js";

export type TaskOutcome = "completed" | "failed" | "ended";
export type TaskNotificationGrouping = "session" | "project";
export interface TaskNotification {
  id: string;
  sessionId: string | null;
  sessionName?: string;
  outcome: TaskOutcome;
  project?: string;
  /** Host-scoped opaque cwd identity; project labels are not unique. */
  projectId?: string;
  grouping?: TaskNotificationGrouping;
  groupingUpdatedAt?: number;
  notificationOwner?: string;
  createdAt: number;
  test?: true;
}
export interface NotificationSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface TaskAlertSettings {
  installationId: string;
  mode: CompletionAttentionPreference | null;
  grouping: TaskNotificationGrouping;
  groupingUpdatedAt: number;
  publicKey: string;
  subscribed: boolean;
  /** Active endpoint, or the last endpoint rejected as expired by the push service. */
  endpoint: string | null;
  error: string | null;
}
export type TaskAlertEvent =
  | { type: "task_notification"; notification: TaskNotification }
  | { type: "task_alert_settings"; settings: TaskAlertSettings };

export interface TaskAlertState {
  mode: CompletionAttentionPreference;
  grouping: TaskNotificationGrouping;
  groupingUpdatedAt: number;
  groupingBusy: boolean;
  groupingError: string | null;
  permission: NotificationPermission | "unavailable";
  subscribed: boolean;
  busy: boolean;
  error: string | null;
  testResult: string | null;
}
export const initialTaskAlerts: TaskAlertState = {
  mode: "off",
  grouping: "session",
  groupingUpdatedAt: 0,
  groupingBusy: false,
  groupingError: null,
  permission: "default",
  subscribed: false,
  busy: false,
  error: null,
  testResult: null,
};
