import type {
  ModelSettingsSnapshot,
  ProviderLoginAttempt,
  ProviderLoginOption,
} from "../../../shared/model-settings";

const modelChoices = [
  {
    provider: "openai",
    id: "gpt-5",
    name: "GPT 5",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
  },
  {
    provider: "anthropic",
    id: "claude-haiku",
    name: "Claude Haiku",
    reasoning: false,
  },
  { provider: "custom", id: "local", name: "Local model", reasoning: true },
];
export function modelSettingsSnapshot(
  overrides: Partial<ModelSettingsSnapshot> = {},
): ModelSettingsSnapshot {
  return {
    settingsRevision: "a".repeat(64),
    configRevision: "b".repeat(64),
    saved: {
      defaultModel: null,
      defaultThinkingLevel: null,
      enabledModels: ["custom/local:high", "openai/gpt-5"],
    },
    effective: {
      defaultModel: null,
      defaultThinkingLevel: null,
      enabledModels: ["custom/local:high", "openai/gpt-5"],
    },
    projectOverrides: [],
    models: structuredClone(modelChoices),
    commonModels: [
      { provider: "custom", id: "local", thinkingLevel: "high" },
      { provider: "openai", id: "gpt-5" },
    ],
    savedCommonEntries: [
      {
        pattern: "custom/local:high",
        models: [{ provider: "custom", id: "local", thinkingLevel: "high" }],
      },
      {
        pattern: "openai/gpt-5",
        models: [{ provider: "openai", id: "gpt-5" }],
      },
    ],
    providers: [
      {
        id: "custom",
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
        apiKeyConfigured: true,
        advancedFields: ["headers", "modelOverrides"],
        models: [
          {
            id: "local",
            name: "Local model",
            contextWindow: 8192,
            maxTokens: 512,
            reasoning: true,
            input: ["text"],
            advancedFields: ["cost", "compat"],
          },
        ],
      },
    ],
    ...overrides,
  };
}
export function loginProviders(): ProviderLoginOption[] {
  return [
    {
      id: "anthropic",
      name: "Anthropic",
      stored: "api_key",
      methods: [
        { type: "api_key", label: "Anthropic API key" },
        { type: "oauth", label: "Claude authorization" },
      ],
    },
    {
      id: "github-copilot",
      name: "GitHub Copilot",
      stored: null,
      methods: [
        {
          type: "oauth",
          label: "GitHub authorization",
          remoteHelp:
            "Open the sign-in link on this device and enter the displayed code.",
        },
      ],
    },
  ];
}
export function pendingLogin(
  overrides: Partial<ProviderLoginAttempt> = {},
): ProviderLoginAttempt {
  return {
    id: "browser-fixture-login",
    provider: "anthropic",
    type: "oauth",
    status: "pending",
    events: [],
    prompt: {
      id: "method",
      type: "select",
      message: "Choose a login method",
      options: [
        { id: "browser", label: "Browser callback" },
        {
          id: "copy_code",
          label: "Copy authorization code",
          remoteHelp:
            "Open the sign-in link on this device, then paste the authorization code here.",
        },
      ],
    },
    ...overrides,
  };
}
