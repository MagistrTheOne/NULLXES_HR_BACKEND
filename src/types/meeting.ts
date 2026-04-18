export type MeetingStatus =
  | "pending"
  | "starting"
  | "in_meeting"
  | "failed_audio_pool_busy"
  | "failed_connect_ws_audio"
  | "stopped_during_meeting"
  | "completed";

export type MeetingTerminalStatus =
  | "failed_audio_pool_busy"
  | "failed_connect_ws_audio"
  | "stopped_during_meeting"
  | "completed";

export type MeetingFailStatus = "failed_audio_pool_busy" | "failed_connect_ws_audio";

export type MeetingStopReason = "manual_stop" | "superseded_by_other_meeting" | "error";

export interface MeetingTransitionEvent {
  id: string;
  meetingId: string;
  fromStatus: MeetingStatus | null;
  toStatus: MeetingStatus;
  reason: string;
  timestampMs: number;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface MeetingRecord {
  meetingId: string;
  triggerSource: string;
  status: MeetingStatus;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  metadata: Record<string, unknown>;
  lastReason?: string;
  schemaVersion: string;
}

export interface StartMeetingInput {
  internalMeetingId: string;
  triggerSource: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
}

export interface StopMeetingInput {
  reason: MeetingStopReason;
  finalStatus?: Extract<MeetingTerminalStatus, "stopped_during_meeting" | "completed">;
  metadata?: Record<string, unknown>;
}

export interface FailMeetingInput {
  status: MeetingFailStatus;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface MeetingStatusWebhookPayload {
  eventType: "meeting.status.changed";
  schemaVersion: string;
  internalMeetingId: string;
  sessionId?: string;
  fromStatus: MeetingStatus | null;
  status: MeetingStatus;
  reason: string;
  timestampMs: number;
  metadata?: Record<string, unknown>;
}

export interface MeetingPostProcessingPayload {
  eventType: "meeting.post_processing.completed";
  schemaVersion: string;
  internalMeetingId: string;
  sessionId?: string;
  timestampMs: number;
  summary: string;
  transcriptReferences: string[];
}

export type MeetingWebhookEvent = MeetingStatusWebhookPayload | MeetingPostProcessingPayload;
