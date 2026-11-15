import type { Express } from "express";
import { hostEndpoints as routes } from "../shared/host-endpoints.js";
import type { ModelSettingsOwner } from "../shared/model-settings.js";
import { savedConfiguration } from "./configuration-file.js";
import { jsonRoute } from "./json-route.js";
import type { McpConfigService } from "./mcp-config.js";
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
  function context({ sessionId, cwd }: ModelSettingsOwner): string | null {
    const root = sessionId ? deps.runtime.sessionCwd(sessionId) : cwd;
    if (sessionId && !root)
      throw requestError(
        "The session is no longer available; reopen Settings",
        409,
      );
    // Project availability belongs to the project file, not user configuration.
    return root ? resolveUserPath(root, process.cwd()) : null;
  }
  function configuration(): McpConfigService {
    if (!deps.mcpConfig)
      throw requestError("MCP configuration is unavailable on this Host", 503);
    return deps.mcpConfig;
  }
  jsonRoute(app, routes.mcpConfig, ({ query }) =>
    configuration().read(context(query)),
  );
  jsonRoute(app, routes.mcpConnection, ({ query, body }) =>
    configuration().readConnection(context(query), body),
  );
  jsonRoute(app, routes.editMcpConfig, async ({ query, body }) => {
    const service = configuration();
    const cwd = context(query);
    await service.save(cwd, body);
    return savedConfiguration(
      () => service.read(cwd),
      "Saved to Pi. Refresh files before the next edit.",
    );
  });
}
