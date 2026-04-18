import { logger } from "../logging/logger";
import type { DataChannelEventPayload, SessionRecord, SessionStatus } from "../types/realtime";

export class InMemorySessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly idleTimeoutMs: number,
    private readonly sweepIntervalMs: number
  ) {}

  startSweeper(): void {
    this.stopSweeper();
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const session of this.sessions.values()) {
        if (session.status === "active" && now - session.lastActivityAt > this.idleTimeoutMs) {
          this.updateStatus(session.id, "closed");
          this.patchSession(session.id, { closedAt: now });
          logger.info({ sessionId: session.id }, "session closed due to inactivity");
        }
      }
    }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  stopSweeper(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  createSession(sessionId: string): SessionRecord {
    const now = Date.now();
    const record: SessionRecord = {
      id: sessionId,
      status: "starting",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      eventCount: 0,
      eventTypeCounts: {}
    };
    this.sessions.set(sessionId, record);
    return record;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const now = Date.now();
    session.updatedAt = now;
    session.lastActivityAt = now;
  }

  patchSession(sessionId: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const now = Date.now();
    Object.assign(session, patch, { updatedAt: now });
    return session;
  }

  updateStatus(sessionId: string, status: SessionStatus): SessionRecord | undefined {
    return this.patchSession(sessionId, { status });
  }

  markError(sessionId: string, message: string): SessionRecord | undefined {
    return this.patchSession(sessionId, { status: "error", lastError: message });
  }

  registerEvent(sessionId: string, event: DataChannelEventPayload): SessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.eventCount += 1;
    session.eventTypeCounts[event.type] = (session.eventTypeCounts[event.type] ?? 0) + 1;
    this.touch(sessionId);
    return session;
  }

  listSessions(): SessionRecord[] {
    return Array.from(this.sessions.values());
  }
}
