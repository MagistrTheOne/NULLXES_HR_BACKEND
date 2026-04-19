import { createHash } from "node:crypto";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";
import type {
  CandidateAdmissionDecision,
  CandidateAdmissionDecisionResult,
  CandidateAdmissionRelease,
  CandidateAdmissionRequest,
  CandidateAdmissionResult,
  CandidateAdmissionStatusView,
  FailMeetingInput,
  MeetingRecord,
  MeetingStatus,
  MeetingTransitionEvent,
  MeetingWebhookEvent,
  StartMeetingInput,
  StopMeetingInput
} from "../types/meeting";
import { AvatarClient, AvatarServiceUnavailableError } from "./avatarClient";
import type { AvatarStateStore } from "./avatarStateStore";
import { MeetingStateMachine } from "./meetingStateMachine";
import { InMemoryMeetingStore } from "./meetingStore";
import { PostMeetingProcessor } from "./postMeetingProcessor";
import type { StreamProvisioner } from "./streamProvisioner";
import { WebhookOutbox } from "./webhookOutbox";

export interface MeetingOrchestratorAvatarDeps {
  client: AvatarClient;
  stateStore: AvatarStateStore;
  /** Optional Stream provisioner; when provided we upsert agent + create call before kickoff. */
  streamProvisioner?: StreamProvisioner;
  /** Stream call type to use for provisioning (defaults match what the pod uses). */
  streamCallType?: string;
}

export class MeetingOrchestrator {
  constructor(
    private readonly store: InMemoryMeetingStore,
    private readonly stateMachine: MeetingStateMachine,
    private readonly webhookOutbox: WebhookOutbox,
    private readonly postMeetingProcessor: PostMeetingProcessor,
    private readonly avatar?: MeetingOrchestratorAvatarDeps
  ) {}

  startMeeting(input: StartMeetingInput): { meeting: MeetingRecord; history: MeetingTransitionEvent[] } {
    if (this.store.exists(input.internalMeetingId)) {
      throw new HttpError(409, `Meeting already exists: ${input.internalMeetingId}`);
    }

    this.store.createMeeting(input);
    this.transition(input.internalMeetingId, "starting", "meeting_start_requested", input.metadata, input.sessionId);
    this.transition(input.internalMeetingId, "in_meeting", "meeting_started", input.metadata, input.sessionId);
    const meeting = this.requireMeeting(input.internalMeetingId);

    // Fire-and-forget avatar pod kickoff. We never await this — the meeting
    // is considered started even if the GPU pod is slow / down. The pod will
    // post back to /avatar/events when it is ready, and the frontend polls
    // /avatar/state/:meetingId to know when to render the live tile.
    this.kickoffAvatar(meeting, input);

    return {
      meeting,
      history: this.store.getMeetingHistory(meeting.meetingId)
    };
  }

  private kickoffAvatar(meeting: MeetingRecord, input: StartMeetingInput): void {
    if (!this.avatar || !this.avatar.client.isConfigured()) {
      return;
    }
    const sessionId = input.sessionId ?? meeting.sessionId ?? meeting.meetingId;
    const interviewContext = (input.metadata?.interviewContext ?? {}) as Record<string, unknown>;
    const candidateName =
      typeof interviewContext.candidateName === "string"
        ? (interviewContext.candidateName as string)
        : undefined;
    const jobTitle =
      typeof interviewContext.jobTitle === "string" ? (interviewContext.jobTitle as string) : undefined;

    const instructions = this.composeOpeningInstructions(jobTitle, candidateName);
    const agentUserId = `agent_${sessionId}`;
    const candidateUserId = `candidate-${meeting.meetingId}`.replace(/[^a-zA-Z0-9_-]/g, "-");
    const agentDisplayName = jobTitle ? `HR · ${jobTitle}` : "HR ассистент";

    this.avatar.stateStore.upsertStart(meeting.meetingId, sessionId, agentUserId);

    const provisioner = this.avatar.streamProvisioner;
    const callType = this.avatar.streamCallType ?? "default";
    const provisionStep = provisioner
      ? provisioner
          .provisionAgentForCall({
            callType,
            callId: meeting.meetingId,
            agentUserId,
            agentDisplayName,
            candidateUserId,
            candidateDisplayName: candidateName ?? "Candidate"
          })
          .then(() => {
            logger.info(
              { meetingId: meeting.meetingId, sessionId, agentUserId, candidateUserId },
              "stream provisioned (user upserted, call created)"
            );
          })
      : Promise.resolve();

    void provisionStep
      .then(() =>
        this.avatar!.client.createSession({
          meetingId: meeting.meetingId,
          sessionId,
          agentDisplayName,
          openaiInstructions: instructions,
          candidateUserId
        })
      )
      .then((response) => {
        logger.info(
          {
            meetingId: meeting.meetingId,
            sessionId,
            podStatus: response.status,
            agentUserId: response.agent_user_id
          },
          "avatar pod kickoff accepted"
        );
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof AvatarServiceUnavailableError) {
          logger.error(
            { meetingId: meeting.meetingId, sessionId, message },
            "avatar pod kickoff failed (pod unavailable) — meeting continues without avatar tile"
          );
        } else {
          logger.error(
            { meetingId: meeting.meetingId, sessionId, message },
            "avatar pod kickoff failed (unexpected)"
          );
        }
        this.avatar?.stateStore.recordEvent(meeting.meetingId, {
          sessionId,
          phase: "failed",
          lastError: message
        });
      });
  }

  private composeOpeningInstructions(jobTitle?: string, candidateName?: string): string {
    const role = jobTitle ?? "позицию в нашей команде";
    const greeting = candidateName ? `${candidateName}, добрый день!` : "Добрый день!";
    return [
      "Ты — AI-интервьюер компании NULLXES. Веди структурированный скрининговый созвон на русском языке.",
      `${greeting} Сначала кратко представься, потом обозначь цель — ознакомительное интервью на ${role}.`,
      "Задавай по одному вопросу за раз. Слушай кандидата, не перебивай. Реплики держи короче 25 секунд.",
      "Если кандидат уходит от темы, мягко возвращай к вопросу. В конце поблагодари и опиши следующий шаг."
    ].join(" ");
  }

  stopMeeting(meetingId: string, input: StopMeetingInput): { meeting: MeetingRecord; transition: MeetingTransitionEvent } {
    this.requireMeeting(meetingId);
    const finalStatus = input.finalStatus ?? "stopped_during_meeting";
    const transition = this.transition(meetingId, finalStatus, input.reason, input.metadata);
    const meeting = this.requireMeeting(meetingId);
    if (finalStatus === "completed") {
      this.postMeetingProcessor.enqueueCompleted(meeting);
    }
    this.teardownAvatar(meetingId);
    return { meeting, transition };
  }

  private teardownAvatar(meetingId: string): void {
    if (!this.avatar || !this.avatar.client.isConfigured()) {
      return;
    }
    const state = this.avatar.stateStore.get(meetingId);
    if (!state) {
      return;
    }
    void this.avatar.client.deleteSession(state.sessionId);
    this.avatar.stateStore.remove(meetingId);
  }

  failMeeting(meetingId: string, input: FailMeetingInput): { meeting: MeetingRecord; transition: MeetingTransitionEvent } {
    this.requireMeeting(meetingId);
    const transition = this.transition(meetingId, input.status, input.reason, input.metadata);
    const meeting = this.requireMeeting(meetingId);
    this.teardownAvatar(meetingId);
    return { meeting, transition };
  }

  getMeeting(meetingId: string): { meeting: MeetingRecord; history: MeetingTransitionEvent[] } {
    const meeting = this.requireMeeting(meetingId);
    return { meeting, history: this.store.getMeetingHistory(meetingId) };
  }

  listMeetings(): MeetingRecord[] {
    return this.store.listMeetings();
  }

  getCandidateAdmission(meetingId: string, participantId?: string): CandidateAdmissionStatusView {
    this.requireMeeting(meetingId);
    const view = this.store.getCandidateAdmission(meetingId, participantId, env.CANDIDATE_ADMISSION_REJOIN_WINDOW_MS);
    if (!view) {
      throw new HttpError(404, `Meeting not found: ${meetingId}`);
    }
    return view;
  }

  acquireCandidateAdmission(meetingId: string, request: CandidateAdmissionRequest): CandidateAdmissionResult {
    this.requireMeeting(meetingId);
    const result = this.store.acquireCandidateAdmission(
      meetingId,
      request,
      env.CANDIDATE_ADMISSION_REJOIN_WINDOW_MS
    );
    if (!result) {
      throw new HttpError(404, `Meeting not found: ${meetingId}`);
    }
    logger.info(
      {
        meetingId,
        participantId: request.participantId,
        granted: result.granted,
        reason: result.reason
      },
      "candidate admission acquire"
    );
    return result;
  }

  releaseCandidateAdmission(
    meetingId: string,
    request: CandidateAdmissionRelease
  ): { released: boolean; status: CandidateAdmissionStatusView } {
    this.requireMeeting(meetingId);
    const result = this.store.releaseCandidateAdmission(
      meetingId,
      request,
      env.CANDIDATE_ADMISSION_REJOIN_WINDOW_MS
    );
    if (!result) {
      throw new HttpError(404, `Meeting not found: ${meetingId}`);
    }
    logger.info(
      {
        meetingId,
        participantId: request.participantId,
        released: result.released,
        reason: request.reason
      },
      "candidate admission release"
    );
    return result;
  }

  decideCandidateAdmission(meetingId: string, decision: CandidateAdmissionDecision): CandidateAdmissionDecisionResult {
    this.requireMeeting(meetingId);
    const result = this.store.decideCandidateAdmission(
      meetingId,
      decision,
      env.CANDIDATE_ADMISSION_REJOIN_WINDOW_MS
    );
    if (!result) {
      throw new HttpError(404, `Meeting not found: ${meetingId}`);
    }
    logger.info(
      {
        meetingId,
        participantId: decision.participantId,
        action: decision.action,
        granted: result.granted,
        decidedBy: decision.decidedBy
      },
      "candidate admission decision"
    );
    return result;
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
