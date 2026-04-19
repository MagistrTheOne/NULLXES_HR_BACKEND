import { logger } from "../logging/logger";

/**
 * In-memory store of the latest avatar pod state per meetingId.
 * Used by:
 *  - GET /meetings/:meetingId (to expose avatarReady flag for the frontend),
 *  - POST /avatar/events (to update phase / errors when the pod calls back).
 *
 * Persistence to Redis is intentionally out of scope for MVP — when the gateway
 * restarts the pod will resend `avatar_ready` on its next heartbeat / the
 * orchestrator will re-issue createSession on the next /meetings/start.
 */

export type AvatarPhase =
  | "starting"
  | "ready"
  | "transcript_delta"
  | "transcript_completed"
  | "response_done"
  | "stopped"
  | "failed";

export interface AvatarState {
  meetingId: string;
  sessionId: string;
  agentUserId?: string;
  phase: AvatarPhase;
  avatarReady: boolean;
  lastEventAt: number;
  lastError?: string;
  startedAt: number;
}

export class AvatarStateStore {
  private readonly states = new Map<string, AvatarState>();

  upsertStart(meetingId: string, sessionId: string, agentUserId: string): void {
    const now = Date.now();
    const existing = this.states.get(meetingId);
    this.states.set(meetingId, {
      meetingId,
      sessionId,
      agentUserId,
      phase: "starting",
      avatarReady: false,
      lastEventAt: now,
      startedAt: existing?.startedAt ?? now,
      lastError: undefined
    });
  }

  recordEvent(
    meetingId: string,
    update: { sessionId: string; phase: AvatarPhase; lastError?: string }
  ): AvatarState | null {
    const existing = this.states.get(meetingId);
    if (!existing) {
      logger.warn({ meetingId, update }, "avatar event for unknown meeting (state store miss)");
      return null;
    }
    if (existing.sessionId !== update.sessionId) {
      logger.warn(
        { meetingId, expectedSessionId: existing.sessionId, gotSessionId: update.sessionId },
        "avatar event session_id mismatch"
      );
    }
    const next: AvatarState = {
      ...existing,
      phase: update.phase,
      avatarReady: update.phase === "ready",
      lastEventAt: Date.now(),
      lastError: update.lastError ?? existing.lastError
    };
    this.states.set(meetingId, next);
    return next;
  }

  get(meetingId: string): AvatarState | undefined {
    return this.states.get(meetingId);
  }

  remove(meetingId: string): void {
    this.states.delete(meetingId);
  }

  list(): AvatarState[] {
    return Array.from(this.states.values());
  }
}
