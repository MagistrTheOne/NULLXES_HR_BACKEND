import { createHash } from "node:crypto";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";
import type {
  FailMeetingInput,
  MeetingRecord,
  MeetingStatus,
  MeetingTransitionEvent,
  MeetingWebhookEvent,
  StartMeetingInput,
  StopMeetingInput
} from "../types/meeting";
import { MeetingStateMachine } from "./meetingStateMachine";
import { InMemoryMeetingStore } from "./meetingStore";
import { PostMeetingProcessor } from "./postMeetingProcessor";
import { WebhookOutbox } from "./webhookOutbox";

export class MeetingOrchestrator {
  constructor(
    private readonly store: InMemoryMeetingStore,
    private readonly stateMachine: MeetingStateMachine,
    private readonly webhookOutbox: WebhookOutbox,
    private readonly postMeetingProcessor: PostMeetingProcessor
  ) {}

  startMeeting(input: StartMeetingInput): { meeting: MeetingRecord; history: MeetingTransitionEvent[] } {
    if (this.store.exists(input.internalMeetingId)) {
      throw new HttpError(409, `Meeting already exists: ${input.internalMeetingId}`);
    }

    this.store.createMeeting(input);
    this.transition(input.internalMeetingId, "starting", "meeting_start_requested", input.metadata, input.sessionId);
    this.transition(input.internalMeetingId, "in_meeting", "meeting_started", input.metadata, input.sessionId);
    const meeting = this.requireMeeting(input.internalMeetingId);
    return {
      meeting,
      history: this.store.getMeetingHistory(meeting.meetingId)
    };
  }

  stopMeeting(meetingId: string, input: StopMeetingInput): { meeting: MeetingRecord; transition: MeetingTransitionEvent } {
    this.requireMeeting(meetingId);
    const finalStatus = input.finalStatus ?? "stopped_during_meeting";
    const transition = this.transition(meetingId, finalStatus, input.reason, input.metadata);
    const meeting = this.requireMeeting(meetingId);
    if (finalStatus === "completed") {
      this.postMeetingProcessor.enqueueCompleted(meeting);
    }
    return { meeting, transition };
  }

  failMeeting(meetingId: string, input: FailMeetingInput): { meeting: MeetingRecord; transition: MeetingTransitionEvent } {
    this.requireMeeting(meetingId);
    const transition = this.transition(meetingId, input.status, input.reason, input.metadata);
    const meeting = this.requireMeeting(meetingId);
    return { meeting, transition };
  }

  getMeeting(meetingId: string): { meeting: MeetingRecord; history: MeetingTransitionEvent[] } {
    const meeting = this.requireMeeting(meetingId);
    return { meeting, history: this.store.getMeetingHistory(meetingId) };
  }

  listMeetings(): MeetingRecord[] {
    return this.store.listMeetings();
  }

  private transition(
    meetingId: string,
    toStatus: MeetingStatus,
    reason: string,
    metadata?: Record<string, unknown>,
    sessionId?: string
  ): MeetingTransitionEvent {
    const meeting = this.requireMeeting(meetingId);
    this.stateMachine.assertTransition(meeting.status, toStatus);
    const transition = this.store.updateMeetingStatus({
      meetingId,
      toStatus,
      reason,
      metadata,
      sessionId
    });

    this.enqueueStatusWebhook(transition);
    logger.info(
      {
        meetingId,
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
        reason
      },
      "meeting status transitioned"
    );
    return transition;
  }

  private enqueueStatusWebhook(transition: MeetingTransitionEvent): void {
    const payload: MeetingWebhookEvent = {
      eventType: "meeting.status.changed",
      schemaVersion: "1.0",
      internalMeetingId: transition.meetingId,
      sessionId: transition.sessionId,
      fromStatus: transition.fromStatus,
      status: transition.toStatus,
      reason: transition.reason,
      timestampMs: transition.timestampMs,
      metadata: transition.metadata
    };
    const idempotencyKey = this.buildIdempotencyKey(payload);
    this.webhookOutbox.enqueue(payload, idempotencyKey);
  }

  private buildIdempotencyKey(payload: MeetingWebhookEvent): string {
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return `${payload.internalMeetingId}:${payload.eventType}:${hash.slice(0, 16)}`;
  }

  private requireMeeting(meetingId: string): MeetingRecord {
    const meeting = this.store.getMeeting(meetingId);
    if (!meeting) {
      throw new HttpError(404, `Meeting not found: ${meetingId}`);
    }
    return meeting;
  }
}
