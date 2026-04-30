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
  MeetingFailureReasonCode,
  StartMeetingInput,
  StopMeetingInput
} from "../types/meeting";
import { AvatarClient, AvatarServiceUnavailableError } from "./avatarClient";
import type { AvatarStateStore } from "./avatarStateStore";
import { MeetingStateMachine } from "./meetingStateMachine";
import { InMemoryMeetingStore } from "./meetingStore";
import { PostMeetingProcessor } from "./postMeetingProcessor";
import type { RuntimeEventStore } from "./runtimeEventStore";
import { StreamRecordingStateError, type StreamRecordingService } from "./streamRecordingService";
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
  private recordingKickoffInFlight = new Set<string>();
  private recordingSettingsEnsured = false;

  constructor(
    private readonly store: InMemoryMeetingStore,
    private readonly stateMachine: MeetingStateMachine,
    private readonly webhookOutbox: WebhookOutbox,
    private readonly postMeetingProcessor: PostMeetingProcessor,
    private readonly avatar?: MeetingOrchestratorAvatarDeps,
    private readonly runtimeEvents?: RuntimeEventStore,
    private readonly streamRecording?: StreamRecordingService
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
    // Best-effort: may be too early (no active session yet). Candidate admission will nudge again.
    this.kickoffRecording(meeting.meetingId, "meeting_start");

    return {
      meeting,
      history: this.store.getMeetingHistory(meeting.meetingId)
    };
  }

  /** Best-effort “nudge” to start Stream recording once call becomes active. */
  nudgeRecordingStart(meetingId: string, reason: string): void {
    this.kickoffRecording(meetingId, reason);
  }

  private kickoffRecording(meetingId: string, reason: string): void {
    if (!this.streamRecording || !this.streamRecording.isConfigured()) {
      return;
    }
    if (this.recordingKickoffInFlight.has(meetingId)) {
      return;
    }
    this.recordingKickoffInFlight.add(meetingId);
    const tryStart = async (): Promise<void> => {
      // Align Stream call type recording settings with product defaults (once per process).
      if (!this.recordingSettingsEnsured) {
        await this.streamRecording!.ensureCallTypeRecordingSettings().catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn({ meetingId, error: message }, "stream recording call type settings update failed");
        });
        this.recordingSettingsEnsured = true;
      }

      const backoff = [2_000, 4_000, 8_000, 15_000, 15_000] as const;
      const maxAttempts = backoff.length;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const snapshot = await this.streamRecording!.start(meetingId);
          this.updateRecordingMetadata(meetingId, {
            stream_recording_state: snapshot.state,
            stream_call_id: snapshot.callId,
            stream_call_type: snapshot.callType,
            stream_recording_id: snapshot.activeRecordingId,
            stream_recording_start_attempts: attempt,
            stream_recording_start_reason: reason,
            stream_recording_last_error: null
          });
          this.enqueueRecordingSignal(meetingId, "recording_auto_started", {
            stream_recording_state: snapshot.state,
            stream_call_id: snapshot.callId,
            stream_call_type: snapshot.callType,
            stream_recording_id: snapshot.activeRecordingId
          });
          logger.info(
            {
              meetingId,
              callType: snapshot.callType,
              callId: snapshot.callId,
              state: snapshot.state,
              recordingId: snapshot.activeRecordingId,
              attempt,
              reason
            },
            "stream recording auto-start attempted"
          );
          return;
        } catch (error) {
          const retryable =
            error instanceof StreamRecordingStateError &&
            (error.code === "not_found" || error.code === "processing" || error.code === "no_active_session");
          if (retryable && attempt < maxAttempts) {
            // Call can exist, but recording may refuse to start until the first participant joins.
            const nextDelayMs = backoff[attempt - 1];
            logger.info(
              {
                meetingId,
                callType: this.streamRecording!.getCallType(),
                callId: meetingId,
                attempt,
                reason,
                errorCode: error instanceof StreamRecordingStateError ? error.code : "unknown",
                nextDelayMs
              },
              "stream recording start transient; scheduling retry"
            );
            this.updateRecordingMetadata(meetingId, {
              stream_recording_state: "starting",
              stream_recording_start_attempts: attempt,
              stream_recording_start_reason: reason
            });
            await new Promise((resolve) => setTimeout(resolve, nextDelayMs));
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          this.updateRecordingMetadata(meetingId, {
            stream_recording_state: "failed",
            stream_recording_error: message,
            stream_recording_last_error: message,
            stream_recording_start_attempts: attempt,
            stream_recording_start_reason: reason
          });
          logger.warn(
            { meetingId, callType: this.streamRecording!.getCallType(), callId: meetingId, error: message, attempt, reason },
            "stream recording auto-start failed"
          );
          return;
        }
      }
    };
    void tryStart().finally(() => {
      this.recordingKickoffInFlight.delete(meetingId);
    });
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
      `${greeting} Представься только как "HR-ассистент NULLXES", затем обозначь цель — ознакомительное интервью на ${role}.`,
      "Говори мягким женским тоном и нейтрально-профессионально.",
      'Говори о себе только в женском роде: "поняла", "готова", "уточнила".',
      "Никогда не комментируй собственный голос, пол, возраст, внешность или происхождение голоса.",
      'Не используй формулировки вроде: "мужской голос", "женский голос", "я мужчина" или "я женщина".',
      "Задавай по одному вопросу за раз. Слушай кандидата, не перебивай. Реплики держи короче 25 секунд.",
      "Если кандидат уходит от темы, мягко возвращай к вопросу. В конце поблагодари и опиши следующий шаг."
    ].join(" ");
  }

  stopMeeting(meetingId: string, input: StopMeetingInput): { meeting: MeetingRecord; transition: MeetingTransitionEvent } {
    this.requireMeeting(meetingId);
    const finalStatus = input.finalStatus ?? "stopped_during_meeting";
    const transition = this.transition(meetingId, finalStatus, input.reason, input.metadata);
    const meeting = this.requireMeeting(meetingId);
    if (finalStatus === "completed" || finalStatus === "stopped_during_meeting") {
      this.postMeetingProcessor.enqueueCompleted(meeting);
    }
    this.stopRecording(meetingId);
    this.teardownAvatar(meetingId);
    return { meeting, transition };
  }

  private stopRecording(meetingId: string): void {
    if (!this.streamRecording || !this.streamRecording.isConfigured()) {
      return;
    }
    void this.streamRecording
      .stop(meetingId)
      .then((snapshot) => {
        const firstAssetWithUrl = snapshot.assets.find((item) => typeof item.url === "string" && item.url.length > 0);
        this.updateRecordingMetadata(meetingId, {
          stream_recording_state: snapshot.state,
          stream_recording_id: snapshot.activeRecordingId,
          stream_recording_url: firstAssetWithUrl?.url,
          stream_recording_filename: firstAssetWithUrl?.filename
        });
      })
      .catch(() => undefined);
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
    const failMetadata = this.buildFailureMetadata(input);
    const transition = this.transition(meetingId, input.status, input.reason, failMetadata);
    const meeting = this.requireMeeting(meetingId);
    logger.warn(
      {
        meetingId,
        status: input.status,
        reason: input.reason,
        reasonCode: failMetadata.failureReasonCode,
        failureSource: failMetadata.failureSource
      },
      "meeting failed"
    );
    this.teardownAvatar(meetingId);
    return { meeting, transition };
  }

  private inferFailureReasonCode(input: FailMeetingInput): MeetingFailureReasonCode {
    const explicit = input.reasonCode;
    if (explicit) {
      return explicit;
    }
    const reason = `${input.reason} ${JSON.stringify(input.metadata ?? {})}`.toLowerCase();
    if (reason.includes("openai client secret")) return "openai_client_secret_failed";
    if (reason.includes("openai") || reason.includes("realtime session failed")) return "openai_call_failed";
    if (reason.includes("stream") || reason.includes("sfu")) return "sfu_join_failed";
    if (reason.includes("timeout") || reason.includes("timed out")) return "network_timeout";
    if (reason.includes("permission") || reason.includes("notallowederror")) return "device_permission_denied";
    if (reason.includes("audio input") || reason.includes("getusermedia")) return "audio_input_unavailable";
    if (reason.includes("upstream") || reason.includes("gateway")) return "gateway_upstream_unreachable";
    return "unknown";
  }

  private buildFailureMetadata(input: FailMeetingInput): Record<string, unknown> {
    const base = { ...(input.metadata ?? {}) };
    const hasReasonCode = typeof base.failureReasonCode === "string" && String(base.failureReasonCode).trim().length > 0;
    if (!hasReasonCode) {
      base.failureReasonCode = this.inferFailureReasonCode(input);
    }
    const hasSource = typeof base.failureSource === "string" && String(base.failureSource).trim().length > 0;
    if (!hasSource) {
      base.failureSource = "meeting.fail.endpoint";
    }
    return base;
  }

  getMeeting(meetingId: string): { meeting: MeetingRecord; history: MeetingTransitionEvent[] } {
    const meeting = this.requireMeeting(meetingId);
    return { meeting, history: this.store.getMeetingHistory(meetingId) };
  }

  updateRecordingMetadata(meetingId: string, patch: Record<string, unknown>): void {
    const meeting = this.requireMeeting(meetingId);
    meeting.metadata = { ...(meeting.metadata ?? {}), ...patch };
    meeting.updatedAt = Date.now();
    const maybePersist = this.store as unknown as { persistMeeting?: (id: string) => Promise<void> };
    if (typeof maybePersist.persistMeeting === "function") {
      void maybePersist.persistMeeting(meetingId);
    }
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
    this.recordRuntimeEvent("candidate.admission.acquire", meetingId, {
      participantId: request.participantId,
      granted: result.granted,
      reason: result.reason
    });
    if (result.granted) {
      // “Dogоняющий” старт записи: кандидат начал подключение к Stream call.
      this.nudgeRecordingStart(meetingId, "candidate_admission_granted");
    }
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
    this.recordRuntimeEvent("candidate.admission.release", meetingId, {
      participantId: request.participantId,
      released: result.released,
      reason: request.reason
    });
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
    this.recordRuntimeEvent("candidate.admission.decision", meetingId, {
      participantId: decision.participantId,
      action: decision.action,
      granted: result.granted,
      decidedBy: decision.decidedBy
    });
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
    this.recordRuntimeEvent("meeting.transition", meetingId, {
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      reason,
      transitionId: transition.id
    }, transition.sessionId);
    return transition;
  }

  private recordRuntimeEvent(
    type: "meeting.transition" | "candidate.admission.acquire" | "candidate.admission.release" | "candidate.admission.decision",
    meetingId: string,
    payload: Record<string, unknown>,
    sessionId?: string
  ): void {
    void this.runtimeEvents?.append({
      type,
      meetingId,
      sessionId,
      actor: "meeting.orchestrator",
      payload
    }).catch(() => undefined);
  }

  private enqueueStatusWebhook(transition: MeetingTransitionEvent): void {
    const terminal =
      transition.toStatus === "completed" ||
      transition.toStatus === "stopped_during_meeting" ||
      transition.toStatus === "failed_audio_pool_busy" ||
      transition.toStatus === "failed_connect_ws_audio";
    const meeting = this.requireMeeting(transition.meetingId);
    const meetingMetadata = meeting.metadata ?? {};
    const enrichedMetadata: Record<string, unknown> = {
      ...meetingMetadata,
      ...(transition.metadata ?? {})
    };
    const rawStreamCallId =
      typeof (meetingMetadata as Record<string, unknown>).stream_call_id === "string"
        ? String((meetingMetadata as Record<string, unknown>).stream_call_id)
        : typeof (meetingMetadata as Record<string, unknown>).streamCallId === "string"
          ? String((meetingMetadata as Record<string, unknown>).streamCallId)
          : "";
    const resolvedStreamCallId = rawStreamCallId.trim() || transition.meetingId;
    const rawStreamCallType =
      typeof (meetingMetadata as Record<string, unknown>).stream_call_type === "string"
        ? String((meetingMetadata as Record<string, unknown>).stream_call_type)
        : typeof (meetingMetadata as Record<string, unknown>).streamCallType === "string"
          ? String((meetingMetadata as Record<string, unknown>).streamCallType)
          : "";
    const resolvedStreamCallType = rawStreamCallType.trim() || env.STREAM_CALL_TYPE;
    if (terminal) {
      enrichedMetadata.stream_call_id = resolvedStreamCallId;
      enrichedMetadata.stream_call_type = resolvedStreamCallType;
      if (typeof meetingMetadata.stream_recording_id === "string" && meetingMetadata.stream_recording_id.trim().length > 0) {
        enrichedMetadata.stream_recording_id = meetingMetadata.stream_recording_id;
      }
      const explicitBinding = Boolean(rawStreamCallId.trim());
      if (!explicitBinding) {
        const jobAiId = (meetingMetadata as Record<string, unknown>).jobAiInterviewId;
        logger.warn(
          { meetingId: transition.meetingId, jobAiId, status: transition.toStatus, streamCallId: resolvedStreamCallId },
          "terminal webhook stream_call_id missing in meeting metadata; using fallback binding"
        );
      }
    }
    const payload: MeetingWebhookEvent = {
      eventType: "meeting.status.changed",
      schemaVersion: "1.0",
      internalMeetingId: transition.meetingId,
      meeting_id: transition.meetingId,
      sessionId: transition.sessionId,
      fromStatus: transition.fromStatus,
      status: transition.toStatus,
      reason: transition.reason,
      timestampMs: transition.timestampMs,
      stream_call_id: resolvedStreamCallId,
      stream_call_type: resolvedStreamCallType,
      metadata: Object.keys(enrichedMetadata).length > 0 ? enrichedMetadata : undefined
    };
    const idempotencyKey = this.buildIdempotencyKey(payload);
    this.webhookOutbox.enqueue(payload, idempotencyKey);
  }

  private enqueueRecordingSignal(meetingId: string, reason: string, metadata: Record<string, unknown>): void {
    const meeting = this.requireMeeting(meetingId);
    const payload: MeetingWebhookEvent = {
      eventType: "meeting.status.changed",
      schemaVersion: "1.0",
      internalMeetingId: meetingId,
      meeting_id: meetingId,
      sessionId: meeting.sessionId,
      fromStatus: meeting.status,
      status: meeting.status,
      reason,
      timestampMs: Date.now(),
      metadata
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
