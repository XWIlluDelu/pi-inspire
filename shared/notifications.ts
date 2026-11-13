import { z } from "zod";
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
  mode: CompletionAttentionPreference;
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

/** A subscription is an outbound capability, not an arbitrary URL to fetch. */
export const pushSubscriptionSchema = z
  .object({
    endpoint: z
      .string()
      .max(4096)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.port &&
          !url.hash &&
          (url.hostname === "fcm.googleapis.com" ||
            url.hostname === "updates.push.services.mozilla.com" ||
            url.hostname === "web.push.apple.com" ||
            url.hostname.endsWith(".push.apple.com") ||
            url.hostname.endsWith(".notify.windows.com"))
        );
      }, "This browser's push service is not supported"),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}={0,1}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}={0,2}$/),
      })
      .strict(),
  })
  .strict();
