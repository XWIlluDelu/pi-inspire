import type { CompletionAttentionPreference } from "./contracts.js";

export type TaskOutcome = "completed" | "failed" | "ended";
export interface TaskNotification {
  id: string;
  sessionId: string | null;
  outcome: TaskOutcome;
  project?: string;
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
  publicKey: string;
  subscribed: boolean;
  endpoint: string | null;
  error: string | null;
}
export type TaskAlertEvent =
  | { type: "task_notification"; notification: TaskNotification }
  | { type: "task_alert_settings"; settings: TaskAlertSettings };

export interface TaskAlertState {
  mode: CompletionAttentionPreference;
  permission: NotificationPermission | "unavailable";
  subscribed: boolean;
  busy: boolean;
  error: string | null;
  testResult: string | null;
}
export const initialTaskAlerts: TaskAlertState = {
  mode: "off",
  permission: "default",
  subscribed: false,
  busy: false,
  error: null,
  testResult: null,
};
