import { z } from "zod";
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_HISTORY_DAYS,
  MAX_TERMINAL_PROFILE_ID_CHARS,
  MAX_TERMINAL_ROWS,
  MAX_TERMINAL_TITLE_CHARS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_HISTORY_DAYS,
  MIN_TERMINAL_ROWS,
  type TerminalCatalogResponse,
  type TerminalDescriptor,
  type TerminalRemoveResponse,
  type TerminalServiceSettings,
} from "./terminal-contracts.js";

export const TERMINAL_OPERATIONS_PATH = "/api/terminal-operations";
export const terminalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u);
export const terminalDimensionsSchema = {
  cols: z.number().int().min(MIN_TERMINAL_COLS).max(MAX_TERMINAL_COLS),
  rows: z.number().int().min(MIN_TERMINAL_ROWS).max(MAX_TERMINAL_ROWS),
};
const cwd = z.string().min(1).max(4_096);
const identity = {
  operationId: z.string().uuid(),
  executor: z
    .object({ kind: z.literal("terminal"), epoch: z.string().uuid() })
    .strict(),
};
export const terminalOperationIdentitySchema = z.object(identity);
export const terminalIntentSchema = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("create"),
      params: z
        .object({
          request: z
            .object({
              cwd,
              profileId: z
                .string()
                .min(1)
                .max(MAX_TERMINAL_PROFILE_ID_CHARS)
                .optional(),
              cols: terminalDimensionsSchema.cols.optional(),
              rows: terminalDimensionsSchema.rows.optional(),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal("rename"),
      params: z
        .object({
          id: terminalIdSchema,
          title: z.string().max(MAX_TERMINAL_TITLE_CHARS).nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal("reorder"),
      params: z
        .object({ projectCwd: cwd, ids: z.array(terminalIdSchema).max(32) })
        .strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal("restart"),
      params: z.object({ id: terminalIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal("remove"),
      params: z.object({ id: terminalIdSchema, force: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal("updateSettings"),
      params: z
        .object({
          patch: z
            .object({
              persistOutput: z.boolean().optional(),
              historyRetentionDays: z
                .number()
                .int()
                .min(MIN_TERMINAL_HISTORY_DAYS)
                .max(MAX_TERMINAL_HISTORY_DAYS)
                .optional(),
            })
            .strict()
            .refine((patch) => Object.keys(patch).length > 0),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal("clearHistory"),
      params: z.object({}).strict(),
    })
    .strict(),
]);
export const terminalOperationSchema = z
  .object({
    ...identity,
    intent: terminalIntentSchema,
  })
  .strict();

export type TerminalIntent = z.output<typeof terminalIntentSchema>;
export type TerminalOperation = z.output<typeof terminalOperationSchema>;
export type TerminalOperationResults = {
  create: TerminalDescriptor;
  rename: TerminalDescriptor;
  reorder: TerminalCatalogResponse;
  restart: TerminalDescriptor;
  remove: TerminalRemoveResponse;
  updateSettings: TerminalServiceSettings;
  clearHistory: null;
};
export function terminalReceiptIdentity(operation: TerminalOperation) {
  return {
    executor: operation.executor,
    operationId: operation.operationId,
    command: operation.intent.command,
  };
}
