import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "http";

let wss: WebSocketServer | null = null;

export function attachWebSocket(server: Server) {
  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "connected" }));
  });
}

// Fire-and-forget: every connected dashboard gets the same event.
// Events are small (a changed node or job row), not full state - the
// dashboard already has the full picture from its initial REST fetch
// and just merges these in.
export function broadcast(type: string, data: unknown) {
  if (!wss) return;
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach((client: WebSocket) => {
    if (client.readyState === client.OPEN) client.send(msg);
  });
}
