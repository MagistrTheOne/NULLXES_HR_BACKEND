import { randomUUID } from "node:crypto";
import type {
  CandidateAdmissionDecision,
  CandidateAdmissionDecisionResult,
  CandidateAdmissionOwner,
  CandidateAdmissionPending,
  CandidateAdmissionRelease,
  CandidateAdmissionRequest,
  CandidateAdmissionResult,
  CandidateAdmissionState,
  CandidateAdmissionStatusView,
  MeetingRecord,
  MeetingStatus,
  MeetingTransitionEvent,
  StartMeetingInput
} from "../types/meeting";

const ADMISSION_KEY = "candidateAdmission";
const PENDING_LIMIT = 5;

function emptyAdmissionState(): CandidateAdmissionState {
  return { owner: null, pending: [], decisions: [] };
}

function readAdmissionState(meeting: MeetingRecord): CandidateAdmissionState {
  const raw = meeting.metadata?.[ADMISSION_KEY] as CandidateAdmissionState | undefined;
  if (!raw || typeof raw !== "object") {
    return emptyAdmissionState();
  }
  return {
    owner: raw.owner ?? null,
    pending: Array.isArray(raw.pending) ? raw.pending : [],
    decisions: Array.isArray(raw.decisions) ? raw.decisions : []
  };
}

function writeAdmissionState(meeting: MeetingRecord, state: CandidateAdmissionState): void {
  meeting.metadata = {
    ...(meeting.metadata ?? {}),
    [ADMISSION_KEY]: state
  };
  meeting.updatedAt = Date.now();
}

function isOwnerActive(owner: CandidateAdmissionOwner | null, now: number, rejoinWindowMs: number): boolean {
  if (!owner) return false;
  return owner.lastSeenAt + rejoinWindowMs >= now;
}

function projectStatus(
  state: CandidateAdmissionState,
  meetingId: string,
  rejoinWindowMs: number,
  participantId: string | undefined,
  now: number
): CandidateAdmissionStatusView {
  const ownerActive = isOwnerActive(state.owner, now, rejoinWindowMs);
  const canCurrentParticipantRejoin =
    !!participantId &&
    (state.owner?.participantId === participantId ||
      (!ownerActive && (!state.owner || state.owner.participantId === participantId)));
  return {
    meetingId,
    rejoinWindowMs,
    owner: state.owner,
    ownerActive,
    pending: state.pending,
    canCurrentParticipantRejoin
  };
}

export class InMemoryMeetingStore {
  protected readonly meetings = new Map<string, MeetingRecord>();
  protected readonly history = new Map<string, MeetingTransitionEvent[]>();

  /** Гидратирует запись и историю из persistent storage без записи новой транзиции. */
  hydrate(record: MeetingRecord, history: MeetingTransitionEvent[]): void {
    this.meetings.set(record.meetingId, record);
    this.history.set(record.meetingId, history);
  }

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

  getCandidateAdmission(
    meetingId: string,
    participantId: string | undefined,
    rejoinWindowMs: number
  ): CandidateAdmissionStatusView | undefined {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return undefined;
    const state = readAdmissionState(meeting);
    return projectStatus(state, meetingId, rejoinWindowMs, participantId, Date.now());
  }

  acquireCandidateAdmission(
    meetingId: string,
    request: CandidateAdmissionRequest,
    rejoinWindowMs: number
  ): CandidateAdmissionResult | undefined {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return undefined;
    const state = readAdmissionState(meeting);
    const now = Date.now();
    const ownerActive = isOwnerActive(state.owner, now, rejoinWindowMs);

    // Same participant resumes — refresh
    if (state.owner?.participantId === request.participantId) {
      state.owner = {
        ...state.owner,
        displayName: request.displayName ?? state.owner.displayName,
        lastSeenAt: now
      };
      // remove from pending if present
      state.pending = state.pending.filter((p) => p.participantId !== request.participantId);
      writeAdmissionState(meeting, state);
      return {
        granted: true,
        reason: "owner_refreshed",
        status: projectStatus(state, meetingId, rejoinWindowMs, request.participantId, now)
      };
    }

    // Free or stale slot — auto-grant
    if (!state.owner || !ownerActive) {
      state.owner = {
        participantId: request.participantId,
        displayName: request.displayName ?? "",
        acquiredAt: now,
        lastSeenAt: now
      };
      state.pending = state.pending.filter((p) => p.participantId !== request.participantId);
      writeAdmissionState(meeting, state);
      return {
        granted: true,
        reason: "auto_granted",
        status: projectStatus(state, meetingId, rejoinWindowMs, request.participantId, now)
      };
    }

    // Slot occupied by an active different owner → enqueue
    const existingPending = state.pending.find((p) => p.participantId === request.participantId);
    if (existingPending) {
      existingPending.lastSeenAt = now;
      existingPending.displayName = request.displayName ?? existingPending.displayName;
    } else {
      if (state.pending.length >= PENDING_LIMIT) {
        // drop oldest
        state.pending.shift();
      }
      state.pending.push({
        participantId: request.participantId,
        displayName: request.displayName ?? "",
        requestedAt: now,
        lastSeenAt: now
      });
    }
    writeAdmissionState(meeting, state);
    return {
      granted: false,
      reason: "awaiting_approval",
      status: projectStatus(state, meetingId, rejoinWindowMs, request.participantId, now)
    };
  }

  releaseCandidateAdmission(
    meetingId: string,
    request: CandidateAdmissionRelease,
    rejoinWindowMs: number
  ): { released: boolean; status: CandidateAdmissionStatusView } | undefined {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return undefined;
    const state = readAdmissionState(meeting);
    const now = Date.now();
    let released = false;

    if (state.owner?.participantId === request.participantId) {
      state.owner = null;
      released = true;
      // Promote first pending to owner per spec
      const next = state.pending.shift();
      if (next) {
        state.owner = {
          participantId: next.participantId,
          displayName: next.displayName,
          acquiredAt: now,
          lastSeenAt: now
        };
      }
    } else {
      // remove from pending if waiting
      const beforeLen = state.pending.length;
      state.pending = state.pending.filter((p) => p.participantId !== request.participantId);
      released = state.pending.length < beforeLen;
    }

    writeAdmissionState(meeting, state);
    return {
      released,
      status: projectStatus(state, meetingId, rejoinWindowMs, request.participantId, now)
    };
  }

  decideCandidateAdmission(
    meetingId: string,
    decision: CandidateAdmissionDecision,
    rejoinWindowMs: number
  ): CandidateAdmissionDecisionResult | undefined {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return undefined;
    const state = readAdmissionState(meeting);
    const now = Date.now();

    state.decisions.push({
      participantId: decision.participantId,
      action: decision.action,
      decidedAt: now,
      decidedBy: decision.decidedBy
    });

    let granted = false;
    if (decision.action === "approve") {
      const pendingIdx = state.pending.findIndex((p) => p.participantId === decision.participantId);
      const pending = pendingIdx >= 0 ? state.pending[pendingIdx] : undefined;
      if (pending) {
        state.pending.splice(pendingIdx, 1);
      }
      // Approve replaces current owner regardless
      state.owner = {
        participantId: decision.participantId,
        displayName: pending?.displayName ?? state.owner?.displayName ?? "",
        acquiredAt: now,
        lastSeenAt: now
      };
      granted = true;
    } else {
      // deny — drop from pending; if matches owner, also evict
      state.pending = state.pending.filter((p) => p.participantId !== decision.participantId);
      if (state.owner?.participantId === decision.participantId) {
        state.owner = null;
      }
      granted = false;
    }

    writeAdmissionState(meeting, state);
    return {
      action: decision.action,
      granted,
      status: projectStatus(state, meetingId, rejoinWindowMs, decision.participantId, now)
    };
  }

  /** Освобождает протухших ownerов в момент чтения статуса (для GET) — без записи. */
  evaluateCandidateAdmission(
    meetingId: string,
    participantId: string | undefined,
    rejoinWindowMs: number
  ): CandidateAdmissionPending[] | undefined {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return undefined;
    return readAdmissionState(meeting).pending;
  }
}
