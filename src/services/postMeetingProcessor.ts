import { logger } from "../logging/logger";
import type { MeetingRecord, MeetingPostProcessingPayload } from "../types/meeting";
import { WebhookOutbox } from "./webhookOutbox";

export class PostMeetingProcessor {
  private readonly queuedMeetings = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly outbox: WebhookOutbox, private readonly intervalMs: number = 1500) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      this.queuedMeetings.clear();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  enqueueCompleted(meeting: MeetingRecord): void {
    if (this.queuedMeetings.has(meeting.meetingId)) {
      return;
    }

    this.queuedMeetings.add(meeting.meetingId);
    const payload: MeetingPostProcessingPayload = {
      eventType: "meeting.post_processing.completed",
      schemaVersion: meeting.schemaVersion,
      internalMeetingId: meeting.meetingId,
      sessionId: meeting.sessionId,
      timestampMs: Date.now(),
      summary: "Meeting completed. Post-processing artifact package queued.",
      transcriptReferences: []
    };
    const idempotencyKey = `${meeting.meetingId}:post-processing:${payload.timestampMs}`;
    this.outbox.enqueue(payload, idempotencyKey);
    logger.info({ meetingId: meeting.meetingId, idempotencyKey }, "post-meeting processing event enqueued");
  }
}
