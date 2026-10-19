import { randomUUID } from "node:crypto";

const REQUEST = "inspire:launcher-restart:v1";
const RESPONSE = "inspire:launcher-restart-result:v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// Only an accepted request followed by this clean shutdown result authorizes
// replacement. A later ordinary stop or crash must never consume a stale intent.
export const HOST_RESTART_EXIT_CODE = 75;

export function createLauncherRestartSupervisor(
  child,
  { enabled, isStopping, assertOwned },
) {
  let requestedId = null;
  const reply = (id, ok) => {
    if (!child.connected) return;
    try {
      child.send({ type: RESPONSE, id, ok }, () => {});
    } catch {
      // Losing a reply cannot turn a normal exit into permission to restart.
    }
  };
  const onMessage = async (message) => {
    if (
      message?.type !== REQUEST ||
      typeof message.id !== "string" ||
      !UUID.test(message.id) ||
      !["inspect", "restart"].includes(message.action)
    )
      return;
    const available = () => enabled && !isStopping() && child.connected;
    if (message.action === "inspect") {
      reply(message.id, available());
      return;
    }
    if (!available() || (requestedId && requestedId !== message.id)) {
      reply(message.id, false);
      return;
    }
    try {
      await assertOwned();
      // Lock inspection yields: recheck stop and competing requests afterwards.
      if (!available() || (requestedId && requestedId !== message.id)) {
        reply(message.id, false);
        return;
      }
      requestedId = message.id;
      reply(message.id, true);
    } catch {
      reply(message.id, false);
    }
  };
  child.on("message", onMessage);
  return {
    shouldRestart: (code, signal) =>
      requestedId !== null &&
      code === HOST_RESTART_EXIT_CODE &&
      signal === null &&
      !isStopping(),
    close: () => child.off("message", onMessage),
  };
}

export function createLauncherRestartClient(channel = process, timeoutMs = 2_000) {
  const exchange = (action) =>
    new Promise((resolve, reject) => {
      if (!channel.connected || !channel.send) {
        reject(new Error("The Inspire launcher is disconnected."));
        return;
      }
      const id = randomUUID();
      let settled = false;
      const finish = (error, ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.off("message", onMessage);
        channel.off("disconnect", onDisconnect);
        if (error) reject(error);
        else resolve(ok);
      };
      const onMessage = (message) => {
        if (
          message?.type === RESPONSE &&
          message.id === id &&
          typeof message.ok === "boolean"
        )
          finish(null, message.ok);
      };
      const onDisconnect = () =>
        finish(new Error("The Inspire launcher disconnected during restart."));
      const timer = setTimeout(
        () => finish(new Error("The Inspire launcher did not confirm restart.")),
        timeoutMs,
      );
      channel.on("message", onMessage);
      channel.on("disconnect", onDisconnect);
      try {
        channel.send({ type: REQUEST, id, action }, (error) => {
          if (error) finish(error);
        });
      } catch (error) {
        finish(error);
      }
    });
  const inspect = async () => {
    try {
      return await exchange("inspect");
    } catch {
      return false;
    }
  };
  return {
    inspect,
    async request(commit) {
      // Preparation may have taken time. Check the live owner before draining.
      if (!(await inspect()) || !commit()) return { code: 1, issued: false };
      // A lost result after commit is uncertain, not proof of non-issuance.
      const issued = await exchange("restart");
      return { code: issued ? 0 : 1, issued };
    },
  };
}
