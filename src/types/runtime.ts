import type { AvatarState } from "../services/avatarStateStore";
import type { CandidateAdmissionStatusView, MeetingRecord, MeetingTransitionEvent } from "./meeting";
import type { StoredInterview } from "./interview";
import type { SessionRecord } from "./realtime";

export type RuntimeEventType =
  | "runtime.snapshot.requested"
  | "runtime.command.requested"
  | "runtime.question_advanced"
  | "meeting.transition"
  | "candidate.admission.acquire"
  | "candidate.admission.release"
  | "candidate.admission.decision"
  | "realtime.session.event"
  | "avatar.event"
  | "stream.token.issued"
  | "observer_command_denied"
  | "runtime.lease.acquired"
  | "runtime.lease.rejected";

export interface RuntimeEvent {
  id: string;
  type: RuntimeEventType;
  meetingId?: string;
  sessionId?: string;
  jobAiId?: number;
  actor?: string;
  timestampMs: number;
  revision: number;
  payload: Record<string, unknown>;
}

export type RuntimeCommandType =
  | "agent.pause"
  | "agent.resume"
  | "agent.cancel_response"
  | "agent.force_next_question"
  | "agent.end_interview"
  | "observer.reconnect"
  | "session.stop";

export interface RuntimeCommandInput {
  type: RuntimeCommandType;
  issuedBy?: string;
  commandId?: string;
  payload?: Record<string, unknown>;
}

export interface RuntimeCommandRecord {
  commandId: string;
  type: RuntimeCommandType;
  meetingId: string;
  issuedBy: string;
  createdAtMs: number;
  ackStatus: "accepted";
  revision: number;
  payload: Record<string, unknown>;
}

export interface RuntimeSnapshot {
  schemaVersion: "1.0";
  generatedAtMs: number;
  meetingId: string;
  jobAiId?: number;
  revision: number;
  meeting: {
    status: MeetingRecord["status"];
    triggerSource: string;
    createdAt: number;
    updatedAt: number;
    lastReason?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    history: MeetingTransitionEvent[];
  };
  session?: SessionRecord;
  interview?: Pick<StoredInterview, "jobAiId" | "projection">;
  admission?: CandidateAdmissionStatusView;
  avatar?: AvatarState | null;
  media: {
    streamCallType: string;
    streamCallId: string;
    candidateUserId: string;
    observerUserIdPrefix: string;
    agentUserId?: string;
  };
  controls: {
    lastCommand?: RuntimeCommandRecord;
    agentPaused: boolean;
  };
  health: {
    ready: boolean;
    warnings: string[];
  };
}
