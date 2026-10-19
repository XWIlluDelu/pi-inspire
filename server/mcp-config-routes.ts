import type { Express } from "express";
import { z } from "zod";
import { type McpConfigService, mcpConfigEditSchema } from "./mcp-config.js";
import { resolveUserPath } from "./paths.js";
import { requestError } from "./request-error.js";
import type { RuntimeLike } from "./runtime.js";

export function registerMcpConfigRoutes(
  app: Express,
  deps: {
    runtime: RuntimeLike;
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
  app.get("/api/mcp-config", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!deps.mcpConfig)
      throw requestError("MCP configuration is unavailable on this Host", 503);
    response.json(await deps.mcpConfig.read(context(request.query)));
  });
  app.patch("/api/mcp-config", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!deps.mcpConfig)
      throw requestError("MCP configuration is unavailable on this Host", 503);
    const edit = mcpConfigEditSchema.safeParse(request.body);
    if (!edit.success)
      throw requestError("Invalid MCP configuration edit", 400);
    const cwd = context(request.query);
    await deps.mcpConfig.save(cwd, edit.data);
    try {
      response.json({ saved: true, snapshot: await deps.mcpConfig.read(cwd) });
    } catch {
      response.json({
        saved: true,
        warning: "Saved to Pi. Refresh files before the next edit.",
      });
    }
  });
}
