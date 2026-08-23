import { z } from "zod";

const MAX_RULES = 100;
const MAX_MAPPINGS = 200;

const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const ruleIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);
const userRuleIdSchema = ruleIdSchema.refine(
  (value) => !value.startsWith("inspire."),
  "The inspire namespace is reserved for shipped rules",
);
const toolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const fieldPathSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((value, context) => {
    const segments = value.split(".");
    const reserved = new Set(["__proto__", "prototype", "constructor"]);
    if (
      segments.some(
        (segment) => !/^[A-Za-z0-9_-]+$/.test(segment) || reserved.has(segment),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Field paths contain only safe dot-separated keys",
      });
      return;
    }
    const [root, second, ...rest] = segments;
    const valid =
      (root === "args" && second !== undefined) ||
      (root === "tool" && second === "name" && rest.length === 0) ||
      (root === "result" &&
        ((second === "text" && rest.length === 0) ||
          (second === "error" && rest.length === 0) ||
          second === "details")) ||
      (root === "thinking" && second === "text" && rest.length === 0);
    if (!valid) {
      context.addIssue({
        code: "custom",
        message:
          "Field paths start with args, result.text, result.error, result.details, tool.name, or thinking.text",
      });
    }
  });

export const toolPresentationValueSchema = z.union([
  z
    .object({
      literal: z.string().max(4_096),
    })
    .strict(),
  z
    .object({
      path: fieldPathSchema,
      fallback: scalarSchema.optional(),
      format: z
        .enum(["text", "json", "first-line", "basename", "count"])
        .optional(),
      prefix: z.string().max(128).optional(),
      suffix: z.string().max(128).optional(),
    })
    .strict(),
]);

const summaryPartSchema = z
  .object({
    kind: z.enum(["text", "resource"]).optional(),
    value: toolPresentationValueSchema,
    reference: toolPresentationValueSchema.optional(),
    separator: z.enum(["space", "dot"]).optional(),
    subdued: z.boolean().optional(),
    optional: z.boolean().optional(),
  })
  .strict();

const propertySchema = z
  .object({
    label: z.string().min(1).max(80),
    value: toolPresentationValueSchema,
    resource: toolPresentationValueSchema.optional(),
    optional: z.boolean().optional(),
  })
  .strict();

const sourceBlockShape = {
  label: z.string().min(1).max(80).optional(),
  source: toolPresentationValueSchema,
  optional: z.boolean().optional(),
};

export const toolPresentationBlockDeclarationSchema = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        type: z.literal("properties"),
        items: z.array(propertySchema).min(1).max(24),
      })
      .strict(),
    z.object({ type: z.literal("text"), ...sourceBlockShape }).strict(),
    z.object({ type: z.literal("markdown"), ...sourceBlockShape }).strict(),
    z
      .object({
        type: z.literal("code"),
        ...sourceBlockShape,
        language: z.string().max(40).optional(),
        lineNumbers: z.boolean().optional(),
      })
      .strict(),
    z.object({ type: z.literal("terminal"), ...sourceBlockShape }).strict(),
    z
      .object({
        type: z.literal("diff"),
        ...sourceBlockShape,
        path: toolPresentationValueSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("notice"),
        source: toolPresentationValueSchema,
        tone: z.enum(["muted", "warning", "error"]).optional(),
        optional: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("list"),
        ...sourceBlockShape,
        root: toolPresentationValueSchema.optional(),
        format: z.enum(["lines", "annotated-lines"]).optional(),
        emptyValues: z.array(z.string().max(256)).max(8).optional(),
        emptyText: z.string().max(256).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("search"),
        ...sourceBlockShape,
        format: z.literal("grouped-lines"),
        emptyValues: z.array(z.string().max(256)).max(8).optional(),
        emptyText: z.string().max(256).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("replacement"),
        label: z.string().min(1).max(80),
        path: toolPresentationValueSchema.optional(),
        oldText: toolPresentationValueSchema,
        newText: toolPresentationValueSchema,
        optional: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("image"),
        label: z.string().min(1).max(80).optional(),
        data: toolPresentationValueSchema,
        mimeType: toolPresentationValueSchema,
        alt: toolPresentationValueSchema,
        optional: z.boolean().optional(),
      })
      .strict(),
  ],
);

const presentationRuleDeclarationSchema = z
  .object({
    summary: z.array(summaryPartSchema).min(1).max(8),
    blocks: z.array(toolPresentationBlockDeclarationSchema).max(20),
  })
  .strict();

type DeclarationPath = Array<string | number>;

function visitFieldPaths(
  value: unknown,
  visit: (fieldPath: string, declarationPath: DeclarationPath) => void,
  declarationPath: DeclarationPath = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      visitFieldPaths(item, visit, [...declarationPath, index]),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...declarationPath, key];
    if (key === "path" && typeof child === "string") visit(child, childPath);
    else visitFieldPaths(child, visit, childPath);
  }
}

function validateCheapSummary(
  value: z.infer<typeof presentationRuleDeclarationSchema>,
  context: z.RefinementCtx,
): void {
  for (const [index, part] of value.summary.entries()) {
    for (const [key, source] of [
      ["value", part.value],
      ["reference", part.reference],
    ] as const) {
      if (!source || !("path" in source)) continue;
      if (source.path === "result.text" || source.format === "json")
        context.addIssue({
          code: "custom",
          path: ["summary", index, key],
          message:
            "Summaries stay cheap: result.text and JSON formatting belong in blocks",
        });
    }
  }
}

export const toolPresentationRuleDeclarationSchema =
  presentationRuleDeclarationSchema.superRefine((value, context) => {
    validateCheapSummary(value, context);
    visitFieldPaths(value, (fieldPath, path) => {
      if (fieldPath.startsWith("thinking."))
        context.addIssue({
          code: "custom",
          path,
          message: "Tool rules cannot select Thinking fields",
        });
    });
  });

export const thinkingPresentationRuleDeclarationSchema =
  presentationRuleDeclarationSchema.superRefine((value, context) => {
    validateCheapSummary(value, context);
    visitFieldPaths(value, (fieldPath, path) => {
      if (fieldPath !== "thinking.text")
        context.addIssue({
          code: "custom",
          path,
          message: "Thinking rules can select only thinking.text",
        });
    });
  });

export const toolPresentationConfigurationSchema = z
  .object({
    version: z.literal(1),
    rules: z.record(userRuleIdSchema, toolPresentationRuleDeclarationSchema),
    mappings: z.record(toolNameSchema, ruleIdSchema),
    thinking: thinkingPresentationRuleDeclarationSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.rules).length > MAX_RULES)
      context.addIssue({
        code: "custom",
        path: ["rules"],
        message: `At most ${MAX_RULES} rules are supported`,
      });
    if (Object.keys(value.mappings).length > MAX_MAPPINGS)
      context.addIssue({
        code: "custom",
        path: ["mappings"],
        message: `At most ${MAX_MAPPINGS} mappings are supported`,
      });
  });

export type ToolPresentationValueDeclaration = z.infer<
  typeof toolPresentationValueSchema
>;
export type ToolPresentationBlockDeclaration = z.infer<
  typeof toolPresentationBlockDeclarationSchema
>;
export type ToolPresentationRuleDeclaration = z.infer<
  typeof toolPresentationRuleDeclarationSchema
>;
export type ThinkingPresentationRuleDeclaration = z.infer<
  typeof thinkingPresentationRuleDeclarationSchema
>;
export type ToolPresentationConfiguration = z.infer<
  typeof toolPresentationConfigurationSchema
>;

export function emptyToolPresentationConfiguration(): ToolPresentationConfiguration {
  return { version: 1, rules: {}, mappings: {} };
}
