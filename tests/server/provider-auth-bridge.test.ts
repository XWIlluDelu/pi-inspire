import { rm } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { registerProviderAuthBridge } from "../../server/extensions/provider-auth-bridge.js";
import { piInstallation } from "../../server/pi-runtime.js";
import {
  nativeOAuthDescriptors,
  ProviderAuthService,
} from "../../server/provider-auth.js";
import {
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
} from "../../shared/branch-bridge-protocol.js";
import { PROVIDER_AUTH_LIMIT } from "../../shared/provider-auth-bridge.js";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "./fixtures/native-pi.js";

vi.mock("../../server/provider-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/provider-auth.js")>()),
  nativeOAuthDescriptors: vi.fn(),
}));

afterEach(() => vi.unstubAllEnvs());

it("retires pending authentication initialization on shutdown without blocking the replacement bridge", async () => {
  const workspace = await nativePiWorkspace("inspire-auth-lifetime-", {});
  stubNativePiEnvironment(workspace.env);
  vi.stubEnv("INSPIRE_PI_SDK_ENTRY", piInstallation.sdkEntryPath);
  let releaseDescriptors!: () => void;
  const descriptors = new Promise<
    Awaited<ReturnType<typeof nativeOAuthDescriptors>>
  >((resolve) => {
    releaseDescriptors = () => resolve(new Map());
  });
  vi.mocked(nativeOAuthDescriptors)
    .mockImplementationOnce(() => descriptors)
    .mockResolvedValue(new Map());
  const request = vi
    .spyOn(ProviderAuthService.prototype, "request")
    .mockResolvedValue(null);
  const owner = {
    command: "inspire_auth_fixture",
    statusKey: "inspire_auth_status_fixture",
    workerId: "worker_auth_fixture",
  };
  const sessionId = "session-auth-fixture";
  const argument = encodeBranchBridgeJson(
    {
      operation: "start",
      provider: "synthetic",
      type: "api_key",
      nonce: "nonce_auth_fixture",
      workerId: owner.workerId,
      sessionId,
    },
    PROVIDER_AUTH_LIMIT,
  );
  const makeBridge = () => {
    let shutdown!: () => void;
    let handler!: (
      argument: string,
      ctx: ExtensionCommandContext,
    ) => Promise<void>;
    registerProviderAuthBridge(
      {
        on: (_name: string, callback: () => void) => {
          shutdown = callback;
        },
        registerCommand: (
          _name: string,
          command: { handler: typeof handler },
        ) => {
          handler = command.handler;
        },
      } as unknown as ExtensionAPI,
      owner,
    );
    const setStatus = vi.fn();
    const ctx = {
      cwd: workspace.cwd,
      mode: "rpc",
      sessionManager: { getSessionId: () => sessionId },
      ui: { setStatus },
    } as unknown as ExtensionCommandContext;
    return {
      shutdown: () => shutdown(),
      run: () => handler(argument, ctx),
      setStatus,
    };
  };
  const old = makeBridge();
  let pending: Promise<void> | undefined;
  const replacement = makeBridge();
  try {
    pending = old.run();
    await vi.waitFor(() =>
      expect(nativeOAuthDescriptors).toHaveBeenCalledOnce(),
    );
    old.shutdown();
    releaseDescriptors();
    await pending;
    expect(request).not.toHaveBeenCalled();
    const response = decodeBranchBridgeJson(
      old.setStatus.mock.calls[0]![1],
      PROVIDER_AUTH_LIMIT,
    );
    expect(response).toMatchObject({ result: null, error: expect.any(String) });

    // A new extension runtime may authenticate; the retired one cannot revive.
    await replacement.run();
    expect(request).toHaveBeenCalledOnce();
    await old.run();
    expect(request).toHaveBeenCalledOnce();
  } finally {
    releaseDescriptors();
    await pending;
    old.shutdown();
    replacement.shutdown();
    await rm(workspace.root, { recursive: true, force: true });
  }
});
