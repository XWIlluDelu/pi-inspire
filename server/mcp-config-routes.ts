import type { Express, Response } from "express";
import { z } from "zod";
import { savedConfiguration } from "./configuration-file.js";
import {
  type McpConfigService,
  mcpConfigEditSchema,
  mcpConnectionReadSchema,
} from "./mcp-config.js";
import { resolveUserPath } from "./paths.js";
import { requestError } from "./request-error.js";
import type { RuntimeController } from "./runtime.js";

export function registerMcpConfigRoutes(
  app: Express,
  deps: {
    runtime: Pick<RuntimeController, "sessionCwd">;
    mcpConfig?: McpConfigService;
  },
) {
  const query = z
    .object({
      sessionId: z.string().min(1).max(256).optional(),
      cwd: z.string().min(1).max(4096).optional(),
    })
    .strict();
  function context(input: unknown): string | null {
    const { sessionId, cwd } = query.parse(input);
    const root = sessionId ? deps.runtime.sessionCwd(sessionId) : cwd;
    if (sessionId && !root)
      throw requestError(
        "The session is no longer available; reopen Settings",
        409,
      );
    // Project availability belongs to the project file, not user configuration.
    return root ? resolveUserPath(root, process.cwd()) : null;
  }
  function configuration(response: Response): McpConfigService {
    response.setHeader("Cache-Control", "no-store");
    if (!deps.mcpConfig)
      throw requestError("MCP configuration is unavailable on this Host", 503);
    return deps.mcpConfig;
  }
  app.get("/api/mcp-config", async (request, response) => {
    response.json(await configuration(response).read(context(request.query)));
  });
  app.post("/api/mcp-config/connection", async (request, response) => {
    const service = configuration(response);
    const input = mcpConnectionReadSchema.safeParse(request.body);
    if (!input.success) throw requestError("Invalid MCP connection read", 400);
    response.json(
      await service.readConnection(context(request.query), input.data),
    );
  });
  app.patch("/api/mcp-config", async (request, response) => {
    const service = configuration(response);
    const edit = mcpConfigEditSchema.safeParse(request.body);
    if (!edit.success)
      throw requestError("Invalid MCP configuration edit", 400);
    const cwd = context(request.query);
    await service.save(cwd, edit.data);
    response.json(
      await savedConfiguration(
        () => service.read(cwd),
        "Saved to Pi. Refresh files before the next edit.",
      ),
    );
  });
}
