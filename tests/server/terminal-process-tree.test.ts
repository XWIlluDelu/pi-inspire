import { describe, expect, it, vi } from "vitest";
import {
  TerminalProcessTree,
  type TerminalTreeInspector,
} from "../../server/terminal-process-tree.js";

function fixture() {
  let exited = false;
  const births = new Map<number, string>([
    [100, "root-original"],
    [101, "child-original"],
  ]);
  const inspector: TerminalTreeInspector = {
    identity: vi.fn(async (pid) => births.get(pid) ?? null),
    descendants: vi.fn(async () => [{ pid: 101, birth: "child-original" }]),
    signal: vi.fn(),
  };
  const tree = new TerminalProcessTree(100, () => exited, inspector);
  return {
    tree,
    births,
    inspector,
    exit: () => {
      exited = true;
    },
  };
}

describe("birth-bound terminal process-tree cleanup", () => {
  it("cleans a captured HUP-resistant child after root exit, never the old root or group", async () => {
    const f = fixture();
    await f.tree.signal("SIGHUP");
    expect(f.inspector.signal).toHaveBeenCalledWith(101, "SIGHUP");
    expect(f.inspector.signal).toHaveBeenCalledWith(-100, "SIGHUP");
    vi.mocked(f.inspector.signal).mockClear();
    vi.mocked(f.inspector.descendants).mockClear();
    f.exit();
    f.births.set(100, "unrelated-new-root");
    await f.tree.signal("SIGKILL");
    expect(f.inspector.descendants).not.toHaveBeenCalled();
    expect(f.inspector.signal).toHaveBeenCalledExactlyOnceWith(101, "SIGKILL");
    f.births.delete(101);
    expect(await f.tree.waitForExit(0)).toBe(true);
  });

  it("refuses a recycled descendant PID and a recycled-root's new children", async () => {
    const f = fixture();
    await f.tree.signal("SIGHUP");
    vi.mocked(f.inspector.signal).mockClear();
    vi.mocked(f.inspector.descendants).mockClear();
    f.exit();
    f.births.set(100, "new-root");
    f.births.set(101, "new-child");
    vi.mocked(f.inspector.descendants).mockResolvedValue([
      { pid: 102, birth: "unrelated-root-child" },
    ]);
    f.births.set(102, "unrelated-root-child");
    await f.tree.signal("SIGKILL");
    expect(f.inspector.descendants).not.toHaveBeenCalled();
    expect(f.inspector.signal).not.toHaveBeenCalled();
    expect(await f.tree.waitForExit(0)).toBe(true);
  });

  it("does not trust stale running state while native onExit is draining", async () => {
    const f = fixture();
    await f.tree.signal("SIGHUP");
    vi.mocked(f.inspector.signal).mockClear();
    vi.mocked(f.inspector.descendants).mockClear();
    f.births.set(100, "new-root");
    await f.tree.signal("SIGKILL");
    expect(f.inspector.descendants).not.toHaveBeenCalled();
    expect(f.inspector.signal).toHaveBeenCalledExactlyOnceWith(101, "SIGKILL");
  });

  it("retains a denied descendant for retry and does not equate kill with confirmed exit", async () => {
    const f = fixture();
    await f.tree.signal("SIGHUP");
    f.exit();
    vi.mocked(f.inspector.signal).mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    await expect(f.tree.signal("SIGKILL")).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(await f.tree.waitForExit(0)).toBe(false);
    await f.tree.signal("SIGKILL");
    expect(await f.tree.waitForExit(0)).toBe(false);
    f.births.set(101, "replacement-child");
    expect(await f.tree.waitForExit(0)).toBe(true);
  });

  it("treats unknown inspection as failure rather than permission or retirement", async () => {
    const f = fixture();
    await f.tree.signal("SIGHUP");
    f.exit();
    vi.mocked(f.inspector.identity).mockRejectedValueOnce(
      new Error("cannot inspect"),
    );
    await expect(f.tree.signal("SIGKILL")).rejects.toThrow("cannot inspect");
    expect(await f.tree.waitForExit(0)).toBe(false);
  });

  it("rechecks root authority before fallback if the group has disappeared", async () => {
    const f = fixture();
    vi.mocked(f.inspector.signal).mockImplementation((pid) => {
      if (pid === -100) {
        f.exit();
        f.births.set(100, "new-root");
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    });
    await f.tree.signal("SIGKILL");
    expect(f.inspector.signal).not.toHaveBeenCalledWith(100, "SIGKILL");
  });

  it("does not promote a PID recycled between ancestry capture and signal validation", async () => {
    const f = fixture();
    vi.mocked(f.inspector.descendants).mockImplementationOnce(async () => {
      f.births.set(101, "unrelated-replacement");
      return [{ pid: 101, birth: "child-original" }];
    });
    await f.tree.signal("SIGKILL");
    expect(f.inspector.signal).not.toHaveBeenCalledWith(101, "SIGKILL");
    expect(f.inspector.signal).toHaveBeenCalledWith(-100, "SIGKILL");
  });

  it("retains unverified descendants when root exits during discovery without signalling them", async () => {
    const f = fixture();
    vi.mocked(f.inspector.descendants).mockImplementationOnce(async () => {
      f.exit();
      return [{ pid: 101, birth: "child-original" }];
    });
    await f.tree.signal("SIGKILL");
    expect(f.inspector.signal).not.toHaveBeenCalled();
    expect(await f.tree.waitForExit(0)).toBe(false);
    f.births.delete(101);
    expect(await f.tree.waitForExit(0)).toBe(true);
  });

  it("uses one batch to validate retained descendants rather than N native lookups", async () => {
    const f = fixture();
    const identities = vi.fn(async () => new Map([[101, "child-original"]]));
    f.inspector.identities = identities;
    await f.tree.signal("SIGHUP");
    expect(identities).toHaveBeenCalledExactlyOnceWith([101]);
    expect(f.inspector.identity).not.toHaveBeenCalledWith(101);
    f.exit();
    identities.mockClear();
    await f.tree.signal("SIGKILL");
    expect(identities).toHaveBeenCalledExactlyOnceWith([101]);
  });

  it("does not forget failed discovery merely because root subsequently exited", async () => {
    const f = fixture();
    vi.mocked(f.inspector.descendants).mockRejectedValueOnce(
      new Error("ps unavailable"),
    );
    await expect(f.tree.signal("SIGHUP")).rejects.toThrow("ps unavailable");
    f.exit();
    await f.tree.signal("SIGKILL");
    await expect(f.tree.waitForExit(0)).rejects.toThrow(
      "discovery was incomplete",
    );
    expect(f.inspector.signal).not.toHaveBeenCalled();
  });

  it("can retry failed discovery while the same live root still proves authority", async () => {
    const f = fixture();
    vi.mocked(f.inspector.descendants).mockRejectedValueOnce(
      new Error("temporary query failure"),
    );
    await expect(f.tree.signal("SIGHUP")).rejects.toThrow(
      "temporary query failure",
    );
    await f.tree.signal("SIGKILL");
    f.exit();
    f.births.delete(101);
    expect(await f.tree.waitForExit(0)).toBe(true);
  });

  it("never starts a tree scan after exit or unknown startup birth", async () => {
    const f = fixture();
    f.exit();
    await f.tree.signal("SIGKILL");
    expect(f.inspector.descendants).not.toHaveBeenCalled();
    expect(f.inspector.signal).not.toHaveBeenCalled();
    const inspector = { ...f.inspector, identity: vi.fn(async () => null) };
    await new TerminalProcessTree(100, () => false, inspector).signal(
      "SIGKILL",
    );
    expect(inspector.descendants).not.toHaveBeenCalled();
    expect(inspector.signal).not.toHaveBeenCalled();
  });
});
