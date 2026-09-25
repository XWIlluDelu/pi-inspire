import type { Socket } from "node:net";

const MAX_RECORD_BYTES = 2 * 1024 * 1024;

/** Read one bounded LF frame, preserving any bytes after it. The caller owns
 * the socket and must serialize reads; a returned socket is paused.
 */
export function readLocalJsonLine(
  socket: Socket,
  signal: AbortSignal,
  maxBytes = MAX_RECORD_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      socket.pause();
      socket.off("data", data);
      socket.off("error", fail);
      socket.off("end", closed);
      socket.off("close", closed);
      signal.removeEventListener("abort", aborted);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () => fail(new Error("Local IPC connection closed"));
    const aborted = () => fail(new Error("Local IPC request cancelled"));
    const data = (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      const end = newline < 0 ? chunk.length : newline;
      bytes += end;
      if (bytes > maxBytes) {
        fail(new Error("Local IPC record exceeded its size limit"));
        return;
      }
      parts.push(chunk.subarray(0, end));
      if (newline < 0) return;
      cleanup();
      if (newline + 1 < chunk.length)
        socket.unshift(chunk.subarray(newline + 1));
      try {
        resolve(JSON.parse(Buffer.concat(parts, bytes).toString("utf8")));
      } catch {
        reject(new Error("Local IPC sent an invalid JSON record"));
      }
    };
    socket.on("data", data);
    socket.once("error", fail);
    socket.once("end", closed);
    socket.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else if (socket.destroyed || socket.readableEnded) closed();
    else socket.resume();
  });
}

export function writeLocalJsonLine(socket: Socket, value: unknown): void {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > MAX_RECORD_BYTES)
    throw new Error("Local IPC request exceeded its size limit");
  socket.write(line);
}
