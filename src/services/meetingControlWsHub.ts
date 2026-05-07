import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { logger } from "../logging/logger";
import type { InterviewSyncService } from "./interviewSyncService";
import type { RuntimeEventStore } from "./runtimeEventStore";
import type { JobAiInterviewStatus, StoredInterview } from "../types/interview";

type ControlWsEvent =
  | {
      eventType: "activity_mode_changed";
      role: "candidate";
      value: "listening" | "speaking";
    }
  | {
      eventType: "activity_mode_changed";
      role: "ai_agent";
      value: "listening" | "speaking" | "thinking" | "paused";
    }
  | {
      eventType: "current_question_changed";
      value: number | null;
    }
  | {
      eventType: "subtitles_delta";
      text: string;
    };

const TERMINAL_JOBAI_STATUSES = new Set<JobAiInterviewStatus>([
  "completed",
  "stopped_during_meeting",
  "canceled",
  "meeting_not_started"
]);

export class MeetingControlWsHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sockets = new Map<number, Set<WebSocket>>();

  constructor(
    private readonly interviews: InterviewSyncService,
    private readonly runtimeEvents?: RuntimeEventStore
  ) {}

  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      const parsed = this.parseMeetingId(req);
      if (!parsed.matches) {
        return;
      }
      if (typeof parsed.meetingId !== "number") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const stored = this.interviews.getInterviewByNumericMeetingId(parsed.meetingId);
      if (!stored) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!this.isAuthorized(req, stored) || this.isTerminal(stored)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req, parsed.meetingId);
      });
    });

    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage, meetingId: number) => {
      this.addSocket(meetingId, ws);
      const internalMeetingId = internalMeetingIdFor(meetingId);
      void this.runtimeEvents?.append({
        type: "meeting.control.ws.connected",
        meetingId: internalMeetingId,
        actor: "frontend",
        payload: { numericMeetingId: meetingId }
      }).catch(() => undefined);
      logger.info({ meetingId, remoteAddress: req.socket.remoteAddress }, "meeting control websocket connected");

      ws.on("message", (data) => {
        this.handleMessage(meetingId, ws, data.toString());
      });
      ws.on("close", () => {
        this.removeSocket(meetingId, ws);
      });
    });
  }

  broadcast(meetingId: number, event: ControlWsEvent): void {
    const payload = JSON.stringify(event);
    const sockets = this.sockets.get(meetingId);
    if (!sockets) {
      return;
    }
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }

  closeMeeting(meetingId: number, reason: string): void {
    const sockets = this.sockets.get(meetingId);
    if (!sockets) {
      return;
    }
    for (const socket of sockets) {
      socket.close(1000, reason);
    }
    this.sockets.delete(meetingId);
  }

  private handleMessage(meetingId: number, ws: WebSocket, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ eventType: "error", errorCode: "invalid_json" }));
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      ws.send(JSON.stringify({ eventType: "error", errorCode: "invalid_payload" }));
      return;
    }
    const event = parsed as Record<string, unknown>;
    if (event.eventType !== "set_pause_enabled" || typeof event.pauseEnabled !== "boolean") {
      ws.send(JSON.stringify({ eventType: "error", errorCode: "unsupported_event" }));
      return;
    }

    const internalMeetingId = internalMeetingIdFor(meetingId);
    const pauseEnabled = event.pauseEnabled;
    void this.runtimeEvents?.append({
      type: "meeting.control.pause_changed",
      meetingId: internalMeetingId,
      actor: "frontend",
      payload: { numericMeetingId: meetingId, pauseEnabled }
    }).catch(() => undefined);
    void this.runtimeEvents?.recordCommand({
      commandId: randomUUID(),
      type: pauseEnabled ? "agent.pause" : "agent.resume",
      meetingId: internalMeetingId,
      issuedBy: "meeting_control_ws",
      createdAtMs: Date.now(),
      ackStatus: "accepted",
      revision: Date.now(),
      payload: { numericMeetingId: meetingId, pauseEnabled }
    }).catch(() => undefined);

    this.broadcast(meetingId, {
      eventType: "activity_mode_changed",
      role: "ai_agent",
      value: pauseEnabled ? "paused" : "listening"
    });
  }

  private addSocket(meetingId: number, ws: WebSocket): void {
    const sockets = this.sockets.get(meetingId) ?? new Set<WebSocket>();
    sockets.add(ws);
    this.sockets.set(meetingId, sockets);
  }

  private removeSocket(meetingId: number, ws: WebSocket): void {
    const sockets = this.sockets.get(meetingId);
    if (!sockets) {
      return;
    }
    sockets.delete(ws);
    if (sockets.size === 0) {
      this.sockets.delete(meetingId);
    }
  }

  private parseMeetingId(req: IncomingMessage): { matches: boolean; meetingId?: number } {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = /^\/ws\/meeting\/(\d+)$/.exec(url.pathname);
    if (!match) {
      return { matches: false };
    }
    const meetingId = Number(match[1]);
    return Number.isSafeInteger(meetingId) && meetingId > 0 ? { matches: true, meetingId } : { matches: true };
  }

  private isAuthorized(req: IncomingMessage, stored: StoredInterview): boolean {
    const auth = req.headers.authorization;
    if (typeof auth !== "string") {
      return false;
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim()) ?? /^Bearer:\s*(.+)$/i.exec(auth.trim());
    return bearer?.[1]?.trim() === stored.projection.meetingControlKey;
  }

  private isTerminal(stored: StoredInterview): boolean {
    return (
      TERMINAL_JOBAI_STATUSES.has(stored.rawPayload.status) ||
      stored.projection.nullxesStatus === "completed" ||
      stored.projection.nullxesStatus === "stopped_during_meeting"
    );
  }
}

function internalMeetingIdFor(meetingId: number): string {
  return `nullxes-meeting-${meetingId}`;
}
