import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export default function providerAuthFixture(pi: ExtensionAPI) {
  const register = (ctx: ExtensionContext, label: string) => {
    const base = ctx.modelRegistry.getProvider("anthropic")!;
    const model = {
      ...base.getModels()[0]!,
      provider: "extension-auth-fixture",
      id: "fixture-model",
      name: "Fixture model",
    };
    pi.registerProvider({
      ...base,
      id: "extension-auth-fixture",
      name: "Extension auth fixture",
      getModels: () => [model],
      auth: {
        apiKey: {
          name: label,
          async login(interaction) {
            return {
              type: "api_key",
              key: await interaction.prompt({ type: "secret", message: label }),
            };
          },
          async resolve({ credential }) {
            return credential?.key
              ? { auth: { apiKey: credential.key } }
              : undefined;
          },
        },
      },
    });
  };
  pi.on("session_start", (_event, ctx) => register(ctx, "Fixture API key"));
  pi.registerCommand("remove-auth-provider", {
    description: "Remove the synthetic provider",
    handler: async () => pi.unregisterProvider("extension-auth-fixture"),
  });
  pi.registerCommand("change-auth-method", {
    description: "Update the synthetic provider method",
    handler: async (_argument, ctx) => register(ctx, "Updated fixture API key"),
  });
}
