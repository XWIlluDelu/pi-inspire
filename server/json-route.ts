import type { Express, Request, Response } from "express";
import { ZodError } from "zod";
import type {
  JsonEndpoint,
  RequestData,
  RequestSchemas,
  RequestSource,
} from "../shared/json-endpoints.js";
import { requestError } from "./request-error.js";

export function jsonRoute<S extends RequestSchemas, Result>(
  app: Express,
  endpoint: JsonEndpoint<S, Result>,
  handle: (
    input: RequestData<NoInfer<S>>,
    request: Request,
    response: Response,
  ) => NoInfer<Result> | Promise<NoInfer<Result>>,
): void {
  app[endpoint.method](endpoint.path, async (request, response) => {
    response.set("Cache-Control", "no-store");
    const input: Partial<Record<RequestSource, unknown>> = {};
    for (const source of ["params", "body", "query"] as const) {
      const schema = endpoint.schemas[source];
      if (!schema) continue;
      try {
        input[source] = schema.parse(request[source]);
      } catch (error) {
        if (
          source === "body" &&
          endpoint.invalidInput &&
          error instanceof ZodError
        )
          throw requestError(endpoint.invalidInput, 400);
        throw error;
      }
    }
    const result = await handle(input as RequestData<S>, request, response);
    if (response.destroyed) return;
    if (result === undefined) response.status(204).end();
    else response.json(result);
  });
}
