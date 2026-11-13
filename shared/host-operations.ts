import { z } from "zod";
import {
  COMPOSER_HISTORY_FILE_REFERENCE,
  COMPOSER_HISTORY_IMAGE_REFERENCE,
} from "./composer-artifact-references.js";
import type {
  ComposerHistoryEntry,
  PendingRecovery,
  UploadedAttachment,
} from "./contracts.js";
import {
  MAX_ATTACHMENTS,
  MAX_PROJECT_FILES,
  MAX_PROMPT_CHARS,
  MAX_SESSION_ID_CHARS,
} from "./contracts.js";

export const INPUT_OPERATION_PATHS = {
  prompt: "/api/prompt",
  abort: "/api/control/abort",
  recover: "/api/pending/recover",
  pending: "/api/pending/operations",
} as const;

const addressedOperation = z.object({
  operationId: z.string().uuid(),
  authorityId: z.string().uuid(),
  sessionId: z.string().min(1).max(MAX_SESSION_ID_CHARS),
  expectedViewId: z.string().min(1).max(240).optional(),
});

export const promptSchema = addressedOperation
  .extend({
    message: z.string().max(MAX_PROMPT_CHARS),
    attachmentIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS).optional(),
    historyArtifacts: z
      .object({
        viewId: z.string().min(1).max(240),
        incarnation: z.string().min(1).max(240).nullable(),
        effectiveLeafId: z.string().min(1).max(240).nullable(),
        imageReferences: z
          .array(z.string().max(800).regex(COMPOSER_HISTORY_IMAGE_REFERENCE))
          .max(MAX_ATTACHMENTS),
        fileReferences: z
          .array(z.string().max(800).regex(COMPOSER_HISTORY_FILE_REFERENCE))
          .max(MAX_ATTACHMENTS + MAX_PROJECT_FILES),
      })
      .strict()
      .refine(
        ({ imageReferences, fileReferences }) =>
          imageReferences.length + fileReferences.length > 0,
      )
      .optional(),
    projectFiles: z
      .array(z.string().max(4_096))
      .max(MAX_PROJECT_FILES)
      .optional(),
    behavior: z.enum(["steer", "followUp"]).optional(),
  })
  .strict();
export const pendingOperationSchema = addressedOperation.strict();
export const pendingOperationRequestSchema = pendingOperationSchema.extend({
  action: z.enum(["recover", "abort"]),
});

export interface HostOperationIdentity {
  operationId: string;
  authorityId: string;
}

export interface HostOperationError {
  message: string;
  status: number;
  matches?: string[];
  code?: string;
  recoveredAttachments?: UploadedAttachment[];
  recoveryId?: string;
}

export type HostOperationResults = {
  prompt: ComposerHistoryEntry | null;
  recover: PendingRecovery;
  abort: PendingRecovery;
};

export type HostOperationCommand = keyof HostOperationResults;

export type HostOperationReceipt<Command extends HostOperationCommand> = {
  executor: { kind: "host"; authorityId: string };
  operationId: string;
  command: Command;
} & (
  | { state: "pending" }
  | { state: "completed"; result: HostOperationResults[Command] }
  | { state: "rejected" | "unknown"; error: HostOperationError }
);

export function hostReceipt<Command extends HostOperationCommand>(
  command: Command,
  identity: HostOperationIdentity,
) {
  return {
    executor: { kind: "host", authorityId: identity.authorityId } as const,
    operationId: identity.operationId,
    command,
  };
}
