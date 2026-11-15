import { z } from "zod";
import {
  MAX_COMPOSER_HISTORY_ENTRIES,
  MAX_SESSION_ID_CHARS,
} from "./contracts.js";

const historyCursor = z.string().min(1).max(2_048);
export const historyAddress = {
  sessionId: z.string().min(1).max(MAX_SESSION_ID_CHARS),
  viewId: z.string().min(1).max(512),
};
const historyStart = z.coerce
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .optional();
export const historyQuerySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...historyAddress,
    kind: z.literal("page"),
    cursor: historyCursor.optional(),
    entryId: z.string().min(1).max(200).optional(),
    direction: z.literal("earlier").optional(),
    leafId: z.string().min(1).max(200).optional(),
  }),
  z.strictObject({
    ...historyAddress,
    kind: z.literal("turns"),
    start: historyStart,
  }),
  z.strictObject({
    ...historyAddress,
    kind: z.literal("branches"),
  }),
  z.strictObject({
    ...historyAddress,
    kind: z.literal("composer"),
    start: z.coerce
      .number()
      .int()
      .min(0)
      .max(MAX_COMPOSER_HISTORY_ENTRIES)
      .optional(),
  }),
  z.strictObject({
    ...historyAddress,
    kind: z.literal("outline"),
    before: z.string().min(1).max(200).optional(),
    query: z.string().max(500).optional(),
    leafId: z.string().min(1).max(200).optional(),
    parentId: z.string().max(200).optional(),
  }),
  z.strictObject({
    ...historyAddress,
    kind: z.literal("entry"),
    targetId: z.string().min(1).max(200),
    offset: historyStart,
    point: z.literal("1").optional(),
    format: z.literal("message").optional(),
  }),
]);

type AddressedQuery = z.output<typeof historyQuerySchema>;
type WithoutAddress<Q> = Q extends AddressedQuery
  ? Omit<Q, "sessionId" | "viewId">
  : never;

export type SessionHistoryQuery = WithoutAddress<AddressedQuery>;
