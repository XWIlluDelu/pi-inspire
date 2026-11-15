import type { z } from "zod";

export type RequestSource = "params" | "query" | "body";
export type RequestSchemas = Partial<Record<RequestSource, z.ZodType>>;

export interface JsonEndpoint<S extends RequestSchemas, Result> {
  method: "get" | "post" | "patch" | "put" | "delete";
  path: `/api/${string}`;
  schemas: S;
  mutation?: boolean;
  timeoutMs?: number | null;
  invalidInput?: string;
  /** Type of the response supplied by the Host handler. */
  result?: Result;
}

export function endpoint<Result>() {
  return <const S extends RequestSchemas = Record<never, never>>(
    method: JsonEndpoint<S, Result>["method"],
    path: JsonEndpoint<S, Result>["path"],
    schemas: S = {} as S,
    options?: Pick<
      JsonEndpoint<S, Result>,
      "mutation" | "timeoutMs" | "invalidInput"
    >,
  ): JsonEndpoint<S, Result> => ({ method, path, schemas, ...options });
}

export type RequestInput<S extends RequestSchemas> = {
  [K in keyof S]: z.input<S[K]>;
};

export type RequestData<S extends RequestSchemas> = {
  [K in keyof S]: z.output<S[K]>;
};
