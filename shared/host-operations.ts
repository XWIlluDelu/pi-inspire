import { z } from "zod";
import {
  COMPOSER_HISTORY_FILE_REFERENCE,
  COMPOSER_HISTORY_IMAGE_REFERENCE,
} from "./composer-artifact-references.js";
import type {
  PendingRecovery,
  UploadedAttachment,
} from "./contracts.js";
import {
  MAX_ATTACHMENTS,
  MAX_PROJECT_FILES,
  MAX_PROMPT_CHARS,
  MAX_SESSION_ID_CHARS,
} from "./contracts.js";
import { endpoint } from "./json-endpoints.js";
import { isJsonRecord } from "./json-record.js";

export const hostOperationIdentitySchema = z
  .object({ operationId: z.string().uuid(), authorityId: z.string().uuid() })
  .strict();

const addressedOperation = hostOperationIdentitySchema.extend({
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
export const operationFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const promptObservationSchema = hostOperationIdentitySchema.extend({
  fingerprint: operationFingerprintSchema.optional(),
});

/** Both the sender and Host serialize the validated fields in schema order. */
export function promptFingerprintInput(
  prompt: z.input<typeof promptSchema>,
): string {
  const {
    operationId,
    authorityId,
    sessionId,
    expectedViewId,
    message,
    attachmentIds,
    historyArtifacts,
    projectFiles,
    behavior,
  } = prompt;
  const history = historyArtifacts && {
    viewId: historyArtifacts.viewId,
    incarnation: historyArtifacts.incarnation,
    effectiveLeafId: historyArtifacts.effectiveLeafId,
    imageReferences: historyArtifacts.imageReferences,
    fileReferences: historyArtifacts.fileReferences,
  };
  return JSON.stringify([
    operationId,
    authorityId,
    sessionId,
    expectedViewId,
    message,
    attachmentIds,
    history,
    projectFiles,
    behavior,
  ]);
}

const pendingOperationSchema = addressedOperation.strict();
const pendingOperationRequestSchema = pendingOperationSchema.extend({
  action: z.enum(["recover", "abort"]),
});

export type PendingOperationRequest = z.infer<
  typeof pendingOperationRequestSchema
>;
export type PendingOperationIdentity = Omit<
  PendingOperationRequest,
  "sessionId" | "action"
>;

export type HostOperationIdentity = z.infer<typeof hostOperationIdentitySchema>;

export interface HostOperationError {
  message: string;
  status: number;
  matches?: string[];
  code?: string;
  recoveredAttachments?: UploadedAttachment[];
  recoveryId?: string;
}

export type HostOperationResults = {
  prompt: null;
  recover: PendingRecovery;
  abort: PendingRecovery;
};

export type HostOperationCommand = keyof HostOperationResults;

export type OperationReceipt<Executor, Command, Result> = {
  executor: Executor;
  operationId: string;
  command: Command;
} & (
  | { state: "pending" }
  | { state: "completed"; result: Result }
  | { state: "rejected" | "unknown"; error: HostOperationError }
);

export type MatchedReceipt = Record<string, unknown> &
  (
    | { state: "pending" }
    | { state: "completed"; result: unknown }
    | {
        state: "unknown" | "rejected";
        error: Record<string, unknown> & { message: string; status: number };
      }
  );

export function matchOperationReceipt(
  value: unknown,
  expected: Pick<
    OperationReceipt<Record<string, string>, string, unknown>,
    "executor" | "operationId" | "command"
  >,
  httpStatus?: number,
): MatchedReceipt | null {
  if (
    !isJsonRecord(value) ||
    !isJsonRecord(value.executor) ||
    value.operationId !== expected.operationId ||
    value.command !== expected.command ||
    Object.keys(value.executor).length !== Object.keys(expected.executor).length
  )
    return null;
  const executor = value.executor;
  if (
    !Object.entries(expected.executor).every(
      ([key, item]) => executor[key] === item,
    )
  )
    return null;
  if (value.state === "pending" || value.state === "completed") {
    if (httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300))
      return null;
    if (value.state === "pending" || "result" in value)
      return value as MatchedReceipt;
  }
  if (value.state === "unknown" || value.state === "rejected") {
    const error = value.error;
    if (
      isJsonRecord(error) &&
      typeof error.message === "string" &&
      typeof error.status === "number" &&
      (httpStatus === undefined ||
        (httpStatus >= 400 && httpStatus === error.status && error.message.length > 0))
    )
      return value as MatchedReceipt;
  }
  return null;
}

export type HostOperationReceipt<Command extends HostOperationCommand> =
  OperationReceipt<
    { kind: "host"; authorityId: string },
    Command,
    HostOperationResults[Command]
  >;

const receiptParams = hostOperationIdentitySchema.pick({ operationId: true });
const pendingAdmission = { body: pendingOperationSchema };
const promptReply = endpoint<HostOperationReceipt<"prompt">>();
const pendingReply = endpoint<HostOperationReceipt<"abort" | "recover">>();
export const inputOperationEndpoints = {
  prompt: promptReply("post", "/api/prompt", { body: promptSchema }),
  observePrompt: promptReply("get", "/api/prompt/:operationId", {
    params: receiptParams,
    query: promptObservationSchema.omit({ operationId: true }).strip(),
  }),
  abort: pendingReply("post", "/api/control/abort", pendingAdmission, {
    timeoutMs: null,
  }),
  recover: pendingReply("post", "/api/pending/recover", pendingAdmission, {
    timeoutMs: null,
  }),
  observePending: pendingReply("get", "/api/pending/operations/:operationId", {
    params: receiptParams,
    query: pendingOperationRequestSchema.omit({ operationId: true }),
  }),
};

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
