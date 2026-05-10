import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import type { RuntimeSnapshot } from "../types/runtime";
import type { AvatarStateStore } from "./avatarStateStore";
import type { InMemoryInterviewStore } from "./interviewStore";
import type { InMemoryMeetingStore } from "./meetingStore";
import type { RuntimeEventStore } from "./runtimeEventStore";
import type { RuntimeSessionStateStore } from "./runtimeSessionStateStore";
import type { InMemorySessionStore } from "./sessionStore";
import type { A2FRuntimeClient } from "./a2f-runtime/runtimeServiceClient";

const ACTIVE_MEETING_STATUSES = new Set(["starting", "in_meeting"]);

export class RuntimeSnapshotService {
  constructor(
    private readonly deps: {
      meetingStore: InMemoryMeetingStore;
      sessionStore: InMemorySessionStore;
      interviewStore: InMemoryInterviewStore;
      avatarStateStore: AvatarStateStore;
      runtimeEvents: RuntimeEventStore;
      sessionStateStore?: RuntimeSessionStateStore;
      a2fRuntime?: A2FRuntimeClient;
      streamCallType: string;
    }
  ) {}

  async getByMeetingId(meetingId: string): Promise<RuntimeSnapshot> {
    const meeting = this.deps.meetingStore.getMeeting(meetingId);
    if (!meeting) {
      throw new HttpError(404, `Runtime not found for meeting: ${meetingId}`);
    }
    const jobAiId = this.extractJobAiId(meeting.metadata);
    const interview = typeof jobAiId === "number" ? this.deps.interviewStore.getByJobAiId(jobAiId) : undefined;
    const session = meeting.sessionId ? this.deps.sessionStore.getSession(meeting.sessionId) : undefined;
    const admission = this.deps.meetingStore.getCandidateAdmission(
      meetingId,
      undefined,
      env.CANDIDATE_ADMISSION_REJOIN_WINDOW_MS
    );
    const avatar = this.deps.avatarStateStore.get(meetingId) ?? null;
    const revision = await this.deps.runtimeEvents.getRevision(meetingId);
    const lastCommand = await this.deps.runtimeEvents.getLastCommand(meetingId);
    const warnings: string[] = [];
    const canonicalState = await this.deps.sessionStateStore?.get(meetingId);
    const a2fStats = this.deps.a2fRuntime?.getStats(meetingId);

    if (!session && meeting.sessionId) {
      warnings.push("session_missing");
    }
    if (!avatar?.avatarReady && ACTIVE_MEETING_STATUSES.has(meeting.status)) {
      warnings.push("avatar_not_ready");
    }
    if (!admission?.owner && ACTIVE_MEETING_STATUSES.has(meeting.status)) {
      warnings.push("candidate_not_admitted");
    }
    if (!canonicalState) {
      warnings.push("canonical_session_state_missing");
    }

    return {
      schemaVersion: "1.0",
      generatedAtMs: Date.now(),
      meetingId,
      jobAiId,
      revision,
      meeting: {
        status: meeting.status,
        triggerSource: meeting.triggerSource,
        createdAt: meeting.createdAt,
        updatedAt: meeting.updatedAt,
        lastReason: meeting.lastReason,
        sessionId: meeting.sessionId,
        metadata: meeting.metadata,
        history: this.deps.meetingStore.getMeetingHistory(meetingId)
      },
      session,
      interview: interview ? { jobAiId: interview.jobAiId, projection: interview.projection } : undefined,
      admission,
      avatar,
      media: {
        provider:
          meeting.metadata?.mediaProvider === "livekit_bridge" ? "livekit_bridge" : "stream",
        streamCallType: this.deps.streamCallType,
        streamCallId: meetingId,
        candidateUserId: `candidate-${meetingId}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
        observerUserIdPrefix: `observer-${meetingId}`,
        agentUserId: avatar?.agentUserId ?? (meeting.sessionId ? `agent_${meeting.sessionId}` : undefined)
      },
      controls: {
        lastCommand,
        agentPaused: lastCommand?.type === "agent.pause"
      },
      a2fRuntime: a2fStats
        ? {
            fps: a2fStats.fps,
            queueDepthMs: a2fStats.queueDepthMs,
            avgLatencyMs: a2fStats.avgLatencyMs,
            p95LatencyMs: a2fStats.p95LatencyMs,
            droppedFrames: a2fStats.droppedFrames,
            outputQueueDepth: a2fStats.outputQueueDepth,
            gpuSlot: a2fStats.gpuSlot
          }
        : undefined,
      canonicalState: canonicalState
        ? {
            activeSpeaker: canonicalState.activeSpeaker,
            phase: canonicalState.phase,
            engine: canonicalState.engine,
            degradationLevel: canonicalState.degradationLevel,
            avatarReady: canonicalState.avatarReady,
            revision: canonicalState.revision,
            updatedAtMs: canonicalState.updatedAtMs
          }
        : undefined,
      health: {
        ready: ACTIVE_MEETING_STATUSES.has(meeting.status) && Boolean(session) && Boolean(canonicalState),
        warnings
      }
    };
  }

  async getByInterviewId(jobAiId: number): Promise<RuntimeSnapshot> {
    const interview = this.deps.interviewStore.getByJobAiId(jobAiId);
    const projectedMeetingId = interview?.projection.nullxesMeetingId;
    const active = this.deps.meetingStore
      .listMeetings()
      .filter((meeting) => {
        if (!ACTIVE_MEETING_STATUSES.has(meeting.status)) {
          return false;
        }
        return this.extractJobAiId(meeting.metadata) === jobAiId;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const meetingId = active?.meetingId ?? projectedMeetingId;
    if (!meetingId) {
      throw new HttpError(404, `Runtime not found for interview: ${jobAiId}`);
    }
    return this.getByMeetingId(meetingId);
  }

  private extractJobAiId(metadata?: Record<string, unknown>): number | undefined {
    const raw = metadata?.jobAiInterviewId;
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
}
