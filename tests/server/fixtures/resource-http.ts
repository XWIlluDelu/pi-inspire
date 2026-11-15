import type request from "supertest";
import type { ResourceDescriptor } from "../../../shared/contracts.js";

export function resourceHttp(
  client: ReturnType<typeof request.agent>,
  sessionId: string,
) {
  const address = (id: string, action: string) =>
    `/api/resources/${id}/${action}`;
  const resolve = (reference: string, workspacePath?: string) =>
    client
      .post("/api/resources/resolve")
      .send({ sessionId, reference, workspacePath });
  const contentPath = (id: string) =>
    `${address(id, "content")}?${new URLSearchParams({ sessionId })}`;
  return {
    resolve,
    async descriptor(
      reference: string,
      workspacePath?: string,
    ): Promise<ResourceDescriptor> {
      return (await resolve(reference, workspacePath).expect(200)).body;
    },
    contentPath,
    content: (id: string) => client.get(contentPath(id)),
    interactive: (id: string, html: string) =>
      client.post(address(id, "interactive")).send({ sessionId, html }),
  };
}
