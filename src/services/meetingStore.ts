import { randomUUID } from "node:crypto";
import type {
  MeetingRecord,
  MeetingStatus,
  MeetingTransitionEvent,
  StartMeetingInput
} from "../types/meeting";

export class InMemoryMeetingStore {
  private readonly meetings = new Map<string, MeetingRecord>();
  private readonly history = new Map<string, MeetingTransitionEvent[]>();

  createMeeting(input: StartMeetingInput): MeetingRecord {
    const now = Date.now();
    const record: MeetingRecord = {
      meetingId: input.internalMeetingId,
      triggerSource: input.triggerSource,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      sessionId: input.sessionId,
      metadata: input.metadata ?? {},
      schemaVersion: "1.0"
    };
    this.meetings.set(record.meetingId, record);
    this.history.set(record.meetingId, [
      {
        id: randomUUID(),
        meetingId: record.meetingId,
        fromStatus: null,
        toStatus: "pending",
        reason: "meeting_created",
        timestampMs: now,
        sessionId: record.sessionId,
        metadata: record.metadata
      }
    ]);
    return record;
  }

  getMeeting(meetingId: string): MeetingRecord | undefined {
    return this.meetings.get(meetingId);
  }

  listMeetings(): MeetingRecord[] {
    return Array.from(this.meetings.values());
  }

  getMeetingHistory(meetingId: string): MeetingTransitionEvent[] {
    return this.history.get(meetingId) ?? [];
  }

  exists(meetingId: string): boolean {
    return this.meetings.has(meetingId);
  }

  updateMeetingStatus(params: {
    meetingId: string;
    toStatus: MeetingStatus;
    reason: string;
    metadata?: Record<string, unknown>;
    sessionId?: string;
  }): MeetingTransitionEvent {
    const meeting = this.meetings.get(params.meetingId);
    if (!meeting) {
      throw new Error(`Meeting not found: ${params.meetingId}`);
    }

    const now = Date.now();
    const transition: MeetingTransitionEvent = {
      id: randomUUID(),
      meetingId: meeting.meetingId,
      fromStatus: meeting.status,
      toStatus: params.toStatus,
      reason: params.reason,
      timestampMs: now,
      sessionId: params.sessionId ?? meeting.sessionId,
      metadata: params.metadata
    };

    meeting.status = params.toStatus;
    meeting.updatedAt = now;
    meeting.lastReason = params.reason;
    if (params.sessionId) {
      meeting.sessionId = params.sessionId;
    }
    if (params.metadata) {
      meeting.metadata = {
        ...meeting.metadata,
        ...params.metadata
      };
    }

    const events = this.history.get(meeting.meetingId) ?? [];
    events.push(transition);
    this.history.set(meeting.meetingId, events);
    return transition;
  }
}
