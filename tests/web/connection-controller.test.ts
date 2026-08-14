// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionController } from "../../src/controllers/connection-controller";

class ImmediateCloseSocket {
  static instances: ImmediateCloseSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    ImmediateCloseSocket.instances.push(this);
  }

  close(): void {
    this.onclose?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  ImmediateCloseSocket.instances = [];
});

describe("ConnectionController", () => {
  it("detaches a replaced socket before an eager close callback can reconnect", () => {
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const patch = vi.fn();
    const onTransportReplaced = vi.fn();
    const onTransportClosed = vi.fn();
    const reconnect = vi.fn();
    const controller = new ConnectionController({
      state: () => ({ bootstrapped: true }),
      patch,
      applyEvent: vi.fn(),
      onTransportReplaced,
      onTransportClosed,
      reconnect,
    });

    controller.connect("first");
    const first = ImmediateCloseSocket.instances[0]!;
    controller.connect("second");

    expect(onTransportReplaced).toHaveBeenCalledOnce();
    expect(onTransportClosed).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
    expect(ImmediateCloseSocket.instances).toHaveLength(2);
    expect(first.url).toContain("token=first");
  });

  it("backs off after an unexpected current-socket close", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", ImmediateCloseSocket);
    const onTransportClosed = vi.fn();
    const reconnect = vi.fn();
    const controller = new ConnectionController({
      state: () => ({ bootstrapped: true }),
      patch: vi.fn(),
      applyEvent: vi.fn(),
      onTransportReplaced: vi.fn(),
      onTransportClosed,
      reconnect,
    });

    controller.connect("retry-token");
    ImmediateCloseSocket.instances[0]!.onclose?.();

    expect(onTransportClosed).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(999);
    expect(reconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reconnect).toHaveBeenCalledWith("retry-token");
  });
});
