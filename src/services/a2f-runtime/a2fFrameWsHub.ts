import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { logger } from "../../logging/logger";
import type { A2FRuntimeClient } from "./runtimeServiceClient";
import type { RuntimeFrameEnvelope, RuntimeFrameFormat } from "./contracts";

type SubscriberCleanup = () => void;

export class A2FFrameWsHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly subscriptions = new Map<WebSocket, SubscriberCleanup>();

  constructor(private readonly runtime: A2FRuntimeClient) {}

  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      const parsed = this.parseRuntimeWs(req);
      if (!parsed.matches) {
        return;
      }
      if (!parsed.meetingId) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req, parsed.meetingId, parsed.format);
      });
    });

    this.wss.on("connection", (ws: WebSocket, _req: IncomingMessage, meetingId: string, format: RuntimeFrameFormat) => {
      const unsubscribe = this.runtime.subscribe(meetingId, {
        format,
        onFrame: (frame) => {
          if (ws.readyState !== WebSocket.OPEN) {
            return;
          }
          if (frame instanceof Uint8Array) {
            ws.send(frame, { binary: true });
            return;
          }
          ws.send(JSON.stringify(frame satisfies RuntimeFrameEnvelope));
        }
      });
      this.subscriptions.set(ws, unsubscribe);
      ws.on("close", () => {
        this.subscriptions.get(ws)?.();
        this.subscriptions.delete(ws);
      });
      ws.on("error", () => {
        this.subscriptions.get(ws)?.();
        this.subscriptions.delete(ws);
      });
      logger.debug({ meetingId, format }, "a2f frame websocket connected");
    });
  }

  private parseRuntimeWs(req: IncomingMessage): { matches: boolean; meetingId?: string; format: RuntimeFrameFormat } {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = /^\/ws\/runtime\/([^/]+)\/facial$/.exec(url.pathname);
    if (!match) {
      return { matches: false, format: "json" };
    }
    const format = url.searchParams.get("format") === "protobuf" ? "protobuf" : "json";
    const meetingId = decodeURIComponent(match[1] ?? "").trim();
    if (!meetingId) {
      return { matches: true, format };
    }
    return { matches: true, meetingId, format };
  }
}

