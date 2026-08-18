import { describe, expect, it } from "vitest";
import {
  parseSshReverseConfig,
  sshCommandArguments,
} from "../../connections/ssh-reverse/runner.mjs";

describe("ssh-reverse connection module", () => {
  it("accepts a small explicit connection configuration", () => {
    expect(
      parseSshReverseConfig(
        [
          "INSPIRE_SSH_TARGET=relay@example.test",
          "INSPIRE_SSH_REMOTE_PORT=14587",
          "INSPIRE_SSH_LOCAL_PORT=4588",
          "INSPIRE_SSH_IDENTITY_FILE=/home/demo/.ssh/inspire-tunnel",
        ].join("\n"),
      ),
    ).toEqual({
      target: "relay@example.test",
      remotePort: 14587,
      localPort: 4588,
      identityFile: "/home/demo/.ssh/inspire-tunnel",
    });
  });

  it("rejects shell-like, duplicate, and unknown configuration", () => {
    expect(() =>
      parseSshReverseConfig(
        "INSPIRE_SSH_TARGET=-oProxyCommand=unsafe\nINSPIRE_SSH_REMOTE_PORT=14587\n",
      ),
    ).toThrow("INSPIRE_SSH_TARGET");
    expect(() =>
      parseSshReverseConfig(
        "INSPIRE_SSH_TARGET=relay\nINSPIRE_SSH_REMOTE_PORT=14587\nINSPIRE_SSH_REMOTE_PORT=14588\n",
      ),
    ).toThrow("INSPIRE_SSH_REMOTE_PORT");
    expect(() =>
      parseSshReverseConfig(
        "INSPIRE_SSH_TARGET=relay\nINSPIRE_SSH_REMOTE_PORT=14587\nUNSAFE=value\n",
      ),
    ).toThrow("UNSAFE");
  });

  it("always requests a loopback-only remote listener", () => {
    const arguments_ = sshCommandArguments(
      {
        target: "relay",
        remotePort: 14587,
        localPort: 4587,
        identityFile: undefined,
      },
      { controlPath: "/private/control", background: true },
    );
    expect(arguments_).toContain("127.0.0.1:14587:127.0.0.1:4587");
    expect(arguments_).toContain("ExitOnForwardFailure=yes");
    expect(arguments_).not.toContain("IdentitiesOnly=yes");
  });

  it("uses an explicit identity only when configured", () => {
    const arguments_ = sshCommandArguments({
      target: "relay",
      remotePort: 14587,
      localPort: 4587,
      identityFile: "/home/demo/.ssh/tunnel",
    });
    expect(arguments_).toContain("/home/demo/.ssh/tunnel");
    expect(arguments_).toContain("IdentitiesOnly=yes");
  });
});
