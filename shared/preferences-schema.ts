import { z } from "zod";
import {
  CONTENT_TEXT_SIZES,
  DESKTOP_SEND_KEYS,
  MAX_SESSION_ID_CHARS,
  PALETTE_PREFERENCES,
  READING_WIDTHS,
  SESSION_ACTION_IDS,
} from "./contracts.js";
import { adapterIdSchema } from "./tool-presentation-config.js";

// Field validators stay default-free here: `.partial()` keeps `.default()`,
// so a patch schema derived from defaulted fields would fill absent keys and
// clobber stored values on every patch.
export const preferenceFields = {
  adapterEnabled: z
    .record(adapterIdSchema, z.boolean())
    .refine((value) => Object.keys(value).length <= 32)
    .optional(),
  herdrEnabled: z.boolean(),
  theme: z.enum(["system", "light", "dark"]),
  palette: z.enum(PALETTE_PREFERENCES),
  titlebarNeedles: z.boolean(),
  contentTextSize: z.enum(CONTENT_TEXT_SIZES),
  readingWidth: z.enum(READING_WIDTHS),
  launch: z.enum(["welcome", "continue"]),
  desktopSendKey: z.enum(DESKTOP_SEND_KEYS),
  projectDisplay: z.enum(["folder", "path"]),
  sessionActionOrder: z
    .array(z.enum(SESSION_ACTION_IDS))
    .max(SESSION_ACTION_IDS.length)
    .refine((order) => new Set(order).size === order.length, {
      message: "Session actions must not repeat",
    })
    // New actions join the end without discarding a saved order.
    .transform((order) => [
      ...order,
      ...SESSION_ACTION_IDS.filter((id) => !order.includes(id)),
    ]),
  recentModelIds: z
    .array(
      z.object({
        provider: z.string().min(1).max(120),
        id: z.string().min(1).max(240),
      }),
    )
    .max(8),
  pinnedSessionIds: z
    .array(z.string().min(1).max(MAX_SESSION_ID_CHARS))
    .max(100),
  pinnedProjectCwds: z.array(z.string().min(1).max(4_096)).max(100),
  hiddenProjectCwds: z.array(z.string().min(1).max(4_096)).max(100),
  hiddenSessionIds: z
    .array(z.string().min(1).max(MAX_SESSION_ID_CHARS))
    .max(500),
  navCollapsedGroups: z.array(z.string().min(1).max(4_096)).max(500),
};

export const preferencesSchema = z.object(preferenceFields).strict();

// Writes are field-scoped patches merged over the stored file, never full
// snapshots, so concurrent writers can only contend on the fields they
// actually changed. Reject unknown patch fields, but preserve existing fields
// belonging to other versions of Inspire.
export const preferencesPatchSchema = preferencesSchema.partial().strict();
