import request from "supertest";
import type { createInspireServer } from "../../server/app";
import { token } from "../server/fixtures/host-api";
import {
  jsonBody,
  type RouteResponse,
  TEST_HOST_AUTHORITY,
} from "../web/helpers";

export function forwardHostRequests({
  authorityId,
  server,
}: Pick<ReturnType<typeof createInspireServer>, "authorityId" | "server">) {
  const local = request.agent(server).set("Authorization", `Bearer ${token}`);
  return async (url: string, init: RequestInit): Promise<RouteResponse> => {
    const path = url.replace(TEST_HOST_AUTHORITY, authorityId);
    const { body, headers, status } = await (init.method === "POST"
      ? local.post(path).send({ ...jsonBody(init), authorityId })
      : init.method === "DELETE"
        ? local.delete(path)
        : local.get(path));
    if (body?.authorityId === authorityId)
      body.authorityId = TEST_HOST_AUTHORITY;
    if (headers["x-inspire-authority"] === authorityId)
      headers["x-inspire-authority"] = TEST_HOST_AUTHORITY;
    return { body, headers, status };
  };
}
