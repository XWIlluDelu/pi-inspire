import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";

/** An owned wire peer, not a WebSocket client: never ACK close or ping frames. */
export async function rawWebSocket(
  url: string,
  headers: Record<string, string>,
) {
  const target = new URL(url);
  const socket = createConnection({
    host: target.hostname,
    port: Number(target.port),
  });
  const messages: Array<Record<string, unknown>> = [];
  const closeCodes: number[] = [];
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let protocolError: Error | undefined;
  let resolveUpgrade!: () => void;
  let rejectUpgrade!: (error: Error) => void;
  const upgrade = new Promise<void>((resolve, reject) => {
    resolveUpgrade = resolve;
    rejectUpgrade = reject;
  });
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => {
      if (!upgraded) rejectUpgrade(new Error("Peer closed before upgrade"));
      resolve();
    });
  });
  socket.on("error", rejectUpgrade);
  socket.on("data", (data) => {
    try {
      buffer = Buffer.concat([
        buffer,
        typeof data === "string" ? Buffer.from(data) : data,
      ]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buffer.length > 16_384)
            throw new Error("Oversized upgrade response");
          return;
        }
        if (!buffer.subarray(0, end).toString().startsWith("HTTP/1.1 101 "))
          throw new Error("Raw WebSocket upgrade was rejected");
        buffer = buffer.subarray(end + 4);
        upgraded = true;
        resolveUpgrade();
      }
      while (buffer.length >= 2) {
        const opcode = buffer[0]! & 15;
        if (buffer[1]! & 128) throw new Error("Server sent a masked frame");
        let length = buffer[1]! & 127;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const largeLength = buffer.readBigUInt64BE(2);
          if (largeLength > 8_388_608n)
            throw new Error("Oversized server frame");
          length = Number(largeLength);
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        if (opcode === 1) messages.push(JSON.parse(payload.toString()));
        if (opcode === 8)
          closeCodes.push(length >= 2 ? payload.readUInt16BE(0) : 1005);
        buffer = buffer.subarray(offset + length);
      }
    } catch (error) {
      protocolError = error as Error;
      socket.destroy(protocolError);
    }
  });
  socket.once("connect", () => {
    const fields = {
      Host: target.host,
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      ...headers,
    };
    socket.write(
      `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
        Object.entries(fields)
          .map(([key, value]) => `${key}: ${value}\r\n`)
          .join("") +
        "\r\n",
    );
  });
  // A missing upgrade must not leak a TCP handle after the test fails.
  socket.setTimeout(2_000, () =>
    socket.destroy(new Error("Raw upgrade timed out")),
  );
  try {
    await upgrade;
  } catch (error) {
    socket.destroy();
    throw error;
  }
  socket.setTimeout(0);
  return {
    messages,
    closeCodes,
    closed,
    get connected() {
      return !socket.destroyed;
    },
    get protocolError() {
      return protocolError;
    },
    destroy: () => socket.destroy(),
    send(value: unknown) {
      const payload = Buffer.from(JSON.stringify(value));
      if (payload.length > 65_535)
        throw new Error("Fixture message is too large");
      const extended = payload.length >= 126;
      const header = Buffer.alloc(extended ? 8 : 6);
      header[0] = 0x81;
      header[1] = 0x80 | (extended ? 126 : payload.length);
      if (extended) header.writeUInt16BE(payload.length, 2);
      const mask = randomBytes(4);
      mask.copy(header, extended ? 4 : 2);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++)
        masked[i] = masked[i]! ^ mask[i % 4]!;
      socket.write(Buffer.concat([header, masked]));
    },
  };
}

/** Fail and clean up before ws's 30-second close timeout. This is a test
 * watchdog, not a new product grace period or an automatic peer ACK. */
export async function closeWithoutPeerAck(
  close: () => Promise<void>,
  peer: Awaited<ReturnType<typeof rawWebSocket>>,
) {
  if (!peer.connected) throw new Error("Raw peer disconnected before shutdown");
  let rescued = false;
  const watchdog = setTimeout(() => {
    rescued = true;
    peer.destroy();
  }, 2_000);
  try {
    await close();
    await peer.closed;
    if (rescued)
      throw new Error("Host shutdown waited for a WebSocket close ACK");
    if (peer.protocolError) throw peer.protocolError;
  } finally {
    clearTimeout(watchdog);
    peer.destroy();
  }
}
