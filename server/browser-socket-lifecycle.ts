import { WebSocket, type WebSocketServer } from "ws";
import { BROWSER_UPGRADE_CLOSE } from "../shared/browser-build.mjs";

interface PeerLiveness {
  responsive: boolean;
  browserBuild: string | null | undefined;
}

const heartbeat = JSON.stringify({ type: "heartbeat" });

export function maintainBrowserSockets<Peer extends PeerLiveness>(
  peers: ReadonlyMap<WebSocket, Peer>,
  intervalMs: number,
  currentBuild: (() => Promise<string | undefined>) | undefined,
  ready: (peer: Peer) => boolean,
  send: (socket: WebSocket, message: string) => boolean,
  detach: (socket: WebSocket) => void,
) {
  let checking = false;
  const timer = setInterval(() => {
    if (!checking && peers.size && currentBuild) {
      checking = true;
      void currentBuild().then((build) => {
        if (!build) return;
        for (const [socket, peer] of peers) {
          if (peer.browserBuild === null || peer.browserBuild === build) continue;
          detach(socket);
          socket.close(BROWSER_UPGRADE_CLOSE, "Reload Inspire");
        }
      }).catch(() => {}).finally(() => { checking = false; });
    }
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
