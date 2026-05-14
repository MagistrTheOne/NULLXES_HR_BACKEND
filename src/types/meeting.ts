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
export type MeetingFailureReasonCode =
  | "openai_call_failed"
  | "openai_client_secret_failed"
  | "sfu_join_failed"
  | "network_timeout"
  | "device_permission_denied"
  | "audio_input_unavailable"
  | "gateway_upstream_unreachable"
  | "unknown";

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
  /** Canonical NULLXES meeting id (e.g. `nullxes-meeting-540995855` or custom slug from scheduler). */
  meetingId: string;
  /** Optional; defaults to `"unspecified"` when omitted. */
  triggerSource?: string;
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
  reasonCode?: MeetingFailureReasonCode;
  metadata?: Record<string, unknown>;
}

export interface MeetingStatusWebhookPayload {
  eventType: "meeting.status.changed";
  schemaVersion: string;
  meetingId: string;
  /** @deprecated Same as `meetingId`; kept for older JobAI parsers. */
  meeting_id?: string;
  sessionId?: string;
  fromStatus: MeetingStatus | null;
  status: MeetingStatus;
  reason: string;
  timestampMs: number;
  /**
   * Stream call binding (SFU) for terminal statuses.
   * Added in v2 contract so downstream systems can attach recordings / dashboards.
   */
  stream_call_id?: string;
  stream_call_type?: string;
  metadata?: Record<string, unknown>;
}

export interface MeetingPostProcessingPayload {
  eventType: "meeting.post_processing.completed";
  schemaVersion: string;
  meetingId: string;
  sessionId?: string;
  timestampMs: number;
  summary: string;
  transcriptReferences: string[];
}

export type MeetingWebhookEvent = MeetingStatusWebhookPayload | MeetingPostProcessingPayload;

export interface CandidateAdmissionOwner {
  participantId: string;
  displayName: string;
  acquiredAt: number;
  lastSeenAt: number;
}

export interface CandidateAdmissionPending {
  participantId: string;
  displayName: string;
  requestedAt: number;
  lastSeenAt: number;
}

export interface CandidateAdmissionDecisionRecord {
  participantId: string;
  action: "approve" | "deny";
  decidedAt: number;
  decidedBy?: string;
}

export interface CandidateAdmissionState {
  owner: CandidateAdmissionOwner | null;
  pending: CandidateAdmissionPending[];
  decisions: CandidateAdmissionDecisionRecord[];
}

export interface CandidateAdmissionRequest {
  participantId: string;
  displayName?: string;
}

export interface CandidateAdmissionRelease {
  participantId: string;
  reason?: string;
}

export interface CandidateAdmissionDecision {
  participantId: string;
  action: "approve" | "deny";
  decidedBy?: string;
}

export interface CandidateAdmissionStatusView {
  meetingId: string;
  rejoinWindowMs: number;
  owner: CandidateAdmissionOwner | null;
  ownerActive: boolean;
  pending: CandidateAdmissionPending[];
  canCurrentParticipantRejoin: boolean;
}

export interface CandidateAdmissionResult {
  granted: boolean;
  reason: "owner_refreshed" | "auto_granted" | "awaiting_approval";
  status: CandidateAdmissionStatusView;
}

export interface CandidateAdmissionDecisionResult {
  action: "approve" | "deny";
  granted: boolean;
  status: CandidateAdmissionStatusView;
}
