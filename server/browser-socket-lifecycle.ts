import { WebSocket, type WebSocketServer } from "ws";

interface PeerLiveness {
  responsive: boolean;
}

const heartbeat = JSON.stringify({ type: "heartbeat" });

export function maintainBrowserSockets<Peer extends PeerLiveness>(
  peers: ReadonlyMap<WebSocket, Peer>,
  intervalMs: number,
  ready: (peer: Peer) => boolean,
  send: (socket: WebSocket, message: string) => boolean,
  detach: (socket: WebSocket) => void,
) {
  const timer = setInterval(() => {
    for (const [socket, peer] of peers) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (peer.responsive) {
        peer.responsive = false;
        try {
          socket.ping();
          if (ready(peer)) send(socket, heartbeat);
          continue;
        } catch {
          // The transport dropped before the probe could be sent.
        }
      }
      detach(socket);
      socket.terminate();
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function terminateUpgradedSockets(websocket: WebSocketServer) {
  await Promise.all([...websocket.clients].map((socket) => {
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    socket.terminate();
    return closed;
  }));
}
