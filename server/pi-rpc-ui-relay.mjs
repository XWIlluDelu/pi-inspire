/** Retains response-bearing public RPC UI across Host disconnection.
 * Both launch backends keep this relay next to Pi. It does not own prompts,
 * history or execution: it remembers dialogs and writes native UI responses.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const MAX_LINE = 4 * 1024 * 1024;
// Unix socket paths are limited to about 104 bytes; TMPDIR can exceed that
// on macOS and in isolated environments.
const SOCKET_PATH_LIMIT = 100;
const METHODS = new Set(["select", "confirm", "input", "editor"]);

/** A bounded observer; the original byte streams remain untouched. */
function observeLines(receive) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let skipped = false;
  return (chunk) => {
    const text = decoder.write(chunk);
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf("\n", start);
      const part = text.slice(start, end < 0 ? undefined : end);
      if (pending.length + part.length > MAX_LINE) {
        pending = "";
        skipped = true;
      } else if (!skipped) pending += part;
      if (end < 0) break;
      if (!skipped) {
        try {
          receive(JSON.parse(pending));
        } catch {
          /* not a UI record */
        }
      }
      pending = "";
      skipped = false;
      start = end + 1;
    }
  };
}

/** Resolves to null when the channel cannot be created: Pi still runs, only
 * dialog recovery after a Host-only restart is unavailable. */
export async function createPiRpcUiRelay() {
  try {
    return await startRelay();
  } catch (error) {
    process.stderr.write(
      `pi-rpc-ui-relay: dialog recovery unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return null;
  }
}

async function socketDirectory() {
  const preferred = tmpdir();
  // mkdtemp's six-character suffix plus "/ui.sock".
  const fits = Buffer.byteLength(join(preferred, "pi-ui-XXXXXX", "ui.sock"));
  return mkdtemp(
    join(
      process.platform === "win32" || fits <= SOCKET_PATH_LIMIT
        ? preferred
        : "/tmp",
      "pi-ui-",
    ),
  );
}

async function startRelay() {
  const directory = await socketDirectory();
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\pi-ui-${randomUUID()}`
      : join(directory, "ui.sock");
  const token = randomBytes(24).toString("base64url");
  const requests = new Map();
  const fences = new Map();
  const sockets = new Set();
  let child;
  let closed = false;
  let closing;
  const snapshot = () => {
    for (const [id, request] of requests)
      if (request.expiresAt !== undefined && request.expiresAt <= Date.now())
        requests.delete(id);
    return [...requests.values()];
  };
  const output = observeLines((record) => {
    if (record.type === "response" && fences.has(record.id)) {
      fences.get(record.id)(
        record.success
          ? null
          : new Error(record.error || "Pi rejected the UI response fence"),
      );
    } else if (
      record.type === "extension_ui_request" &&
      METHODS.has(record.method) &&
      typeof record.id === "string"
    ) {
      requests.set(record.id, {
        ...record,
        ...(typeof record.timeout === "number" && record.timeout > 0
          ? { expiresAt: Date.now() + record.timeout }
          : {}),
      });
    }
  });
  const input = observeLines((record) => {
    if (record.type === "extension_ui_response") requests.delete(record.id);
  });
  const answer = async (response) => {
    snapshot();
    if (
      !response ||
      typeof response.id !== "string" ||
      !requests.has(response.id)
    )
      throw new Error("The extension question is no longer pending.");
    if (!child || closed || !child.stdin.writable)
      throw new Error("The Pi input channel is unavailable.");
    const request = requests.get(response.id);
    if (
      response.cancelled !== true &&
      (request.method === "confirm"
        ? typeof response.confirmed !== "boolean"
        : typeof response.value !== "string")
    )
      throw new Error("Invalid extension answer.");
    // One submitted answer consumes this question. Neither a timeout nor a
    // lost reply causes an automatic replay.
    requests.delete(response.id);
    const id = `pi-ui-${randomUUID()}`;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("Pi did not confirm the extension answer.")),
        15_000,
      );
      const finish = (error) => {
        if (!fences.delete(id)) return;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      fences.set(id, finish);
      child.stdin.write(
        JSON.stringify({
          type: "extension_ui_response",
          id: response.id,
          ...(response.cancelled === true
            ? { cancelled: true }
            : request.method === "confirm"
              ? { confirmed: response.confirmed }
              : { value: response.value }),
        }) +
          "\n" +
          JSON.stringify({ type: "get_state", id }) +
          "\n",
        (error) => {
          if (error) finish(error);
        },
      );
    });
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(20_000, () => socket.destroy());
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      handled = true;
      const reply = (value) => socket.end(JSON.stringify(value) + "\n");
      void (async () => {
        const request = JSON.parse(buffer.slice(0, end));
        const given = Buffer.from(String(request.token ?? ""));
        if (
          given.length !== Buffer.byteLength(token) ||
          !timingSafeEqual(given, Buffer.from(token))
        )
          throw new Error("Not authorized.");
        if (request.op === "state") return { ok: true, requests: snapshot() };
        if (request.op !== "ui_response")
          throw new Error("Unsupported UI operation.");
        await answer(request.response);
        return { ok: true };
      })().then(reply, (error) =>
        reply({ ok: false, code: "UI_RESPONSE_FAILED", error: error.message }),
      );
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    environment: JSON.stringify({ endpoint, token, parentPid: process.pid }),
    observeInput: input,
    attach(process) {
      child = process;
      child.stdout.on("data", output);
      child.once("exit", () => {
        void this.close();
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        for (const finish of fences.values())
          finish(
            new Error("Pi exited before confirming the extension answer."),
          );
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}
