import express, { type Request, type Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";
import { env } from "../config/env";
import { MeetingOrchestrator } from "../services/meetingOrchestrator";
import type { InterviewSyncService } from "../services/interviewSyncService";
import { saveAssistantAudioArtifact } from "../services/assistantAudioArtifacts";
import { StreamRecordingStateError, type StreamRecordingService } from "../services/streamRecordingService";
import type { FailMeetingInput, StartMeetingInput, StopMeetingInput } from "../types/meeting";

const startMeetingSchema = z.object({
  internalMeetingId: z.string().min(1),
  triggerSource: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  sessionId: z.string().min(1).optional()
});

const stopMeetingSchema = z.object({
  reason: z.enum(["manual_stop", "superseded_by_other_meeting", "error"]),
  finalStatus: z.enum(["stopped_during_meeting", "completed"]).optional(),
  metadata: z.record(z.unknown()).optional()
});

const failMeetingSchema = z.object({
  status: z.enum(["failed_audio_pool_busy", "failed_connect_ws_audio"]),
  reason: z.string().min(1),
  reasonCode: z
    .enum([
      "openai_call_failed",
      "openai_client_secret_failed",
      "sfu_join_failed",
      "network_timeout",
      "device_permission_denied",
      "audio_input_unavailable",
      "gateway_upstream_unreachable",
      "unknown"
    ])
    .optional(),
  metadata: z.record(z.unknown()).optional()
});

const admissionAcquireSchema = z.object({
  participantId: z.string().min(1),
  displayName: z.string().min(1).optional()
});

const admissionReleaseSchema = z.object({
  participantId: z.string().min(1),
  reason: z.string().max(200).optional()
});

const admissionDecisionSchema = z.object({
  participantId: z.string().min(1),
  action: z.enum(["approve", "deny"]),
  decidedBy: z.string().min(1).max(120).optional()
});

const recordingStartSchema = z.object({
  callType: z.string().min(1).optional(),
  callId: z.string().min(1).optional()
});

const recordingSyncSchema = z.object({
  jobAiId: z.number().int().positive(),
  callType: z.string().min(1).optional(),
  callId: z.string().min(1).optional()
});

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function parseBody<T>(schema: z.ZodSchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, "Invalid request payload", parsed.error.flatten());
  }
  return parsed.data;
}

export function createMeetingRouter(
  orchestrator: MeetingOrchestrator,
  deps?: {
    recordings?: StreamRecordingService;
    interviews?: InterviewSyncService;
  }
): express.Router {
  const router = express.Router();

  router.post(
    "/:meetingId/artifacts/assistant-audio",
    express.raw({ type: "*/*", limit: env.ASSISTANT_AUDIO_MAX_BYTES }),
    asyncHandler(async (req: Request, res: Response) => {
      const meetingId = req.params.meetingId;
      const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/octet-stream";
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");
      if (!bytes.byteLength) {
        throw new HttpError(400, "assistant_audio_empty");
      }
      const saved = await saveAssistantAudioArtifact({ meetingId, bytes, contentType });
      orchestrator.updateRecordingMetadata(meetingId, {
        assistant_audio_url: saved.publicUrlPath,
        assistant_audio_filename: saved.filename,
        assistant_audio_bytes: saved.bytes,
        assistant_audio_content_type: saved.contentType
      });
      logger.info(
        { meetingId, bytes: saved.bytes, filename: saved.filename },
        "assistant audio artifact saved"
      );
      res.status(201).json({
        ok: true,
        artifact: {
          url: saved.publicUrlPath,
          filename: saved.filename,
          bytes: saved.bytes,
          contentType: saved.contentType
        }
      });
    })
  );

  router.post("/start", asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody<StartMeetingInput>(startMeetingSchema, req.body);
    const metadata = (input.metadata ?? {}) as Record<string, unknown>;
    const interviewContext = (metadata.interviewContext ?? {}) as Record<string, unknown>;
    const contextProbe = {
      hasJobTitle: typeof interviewContext.jobTitle === "string" && interviewContext.jobTitle.trim().length > 0,
      hasVacancyText: typeof interviewContext.vacancyText === "string" && interviewContext.vacancyText.trim().length > 0,
      hasCompanyName: typeof interviewContext.companyName === "string" && interviewContext.companyName.trim().length > 0,
      questionCount: Array.isArray(interviewContext.questions) ? interviewContext.questions.length : 0
    };

    logger.info(
      {
        requestId: req.requestId,
        internalMeetingId: input.internalMeetingId,
        triggerSource: input.triggerSource,
        contextProbe
      },
      "meeting start received with interview context probe"
    );

    const result = orchestrator.startMeeting(input);
    res.status(201).json(result);
  }));

  router.post("/:meetingId/stop", asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody<StopMeetingInput>(stopMeetingSchema, req.body);
    const result = orchestrator.stopMeeting(req.params.meetingId, input);
    res.status(200).json(result);
  }));

  router.post("/:meetingId/fail", asyncHandler(async (req: Request, res: Response) => {
    const input = parseBody<FailMeetingInput>(failMeetingSchema, req.body);
    const result = orchestrator.failMeeting(req.params.meetingId, input);
    res.status(200).json(result);
  }));

  router.get("/:meetingId", (req: Request, res: Response) => {
    const result = orchestrator.getMeeting(req.params.meetingId);
    res.status(200).json(result);
  });

  router.get("/", (_req: Request, res: Response) => {
    res.status(200).json({
      meetings: orchestrator.listMeetings()
    });
  });

  // ---------------- candidate admission ----------------

  router.get("/:meetingId/admission/candidate", (req: Request, res: Response) => {
    const meetingId = req.params.meetingId;
    const participantIdRaw = req.query.participantId;
    const participantId = typeof participantIdRaw === "string" ? participantIdRaw : undefined;
    const view = orchestrator.getCandidateAdmission(meetingId, participantId);
    res.status(200).json(view);
  });

  router.post("/:meetingId/admission/candidate/acquire", (req: Request, res: Response) => {
    const input = parseBody(admissionAcquireSchema, req.body);
    const result = orchestrator.acquireCandidateAdmission(req.params.meetingId, input);
    if (result.granted) {
      res.status(200).json(result.status);
      return;
    }
    res.status(423).json({
      error: "AdmissionAwaitingApproval",
      message: "Кандидат уже подключен, ожидайте подтверждение HR.",
      code: "admission.awaiting_approval",
      ...result.status
    });
  });

  router.post("/:meetingId/admission/candidate/release", (req: Request, res: Response) => {
    const input = parseBody(admissionReleaseSchema, req.body);
    const result = orchestrator.releaseCandidateAdmission(req.params.meetingId, input);
    res.status(200).json({
      released: result.released,
      owner: result.status.owner,
      pending: result.status.pending,
      meetingId: result.status.meetingId,
      rejoinWindowMs: result.status.rejoinWindowMs,
      ownerActive: result.status.ownerActive,
      canCurrentParticipantRejoin: result.status.canCurrentParticipantRejoin
    });
  });

  router.post("/:meetingId/admission/candidate/decision", (req: Request, res: Response) => {
    const input = parseBody(admissionDecisionSchema, req.body);
    const result = orchestrator.decideCandidateAdmission(req.params.meetingId, input);
    res.status(200).json({
      action: result.action,
      granted: result.granted,
      owner: result.status.owner,
      pending: result.status.pending,
      meetingId: result.status.meetingId,
      rejoinWindowMs: result.status.rejoinWindowMs,
      ownerActive: result.status.ownerActive,
      canCurrentParticipantRejoin: result.status.canCurrentParticipantRejoin
    });
  });

  router.get("/:meetingId/recording", asyncHandler(async (req: Request, res: Response) => {
    const meetingId = req.params.meetingId;
    orchestrator.getMeeting(meetingId);
    const callType = typeof req.query.callType === "string" && req.query.callType.trim().length > 0
      ? req.query.callType.trim()
      : undefined;
    const callId = typeof req.query.callId === "string" && req.query.callId.trim().length > 0
      ? req.query.callId.trim()
      : meetingId;

    if (!deps?.recordings || !deps.recordings.isConfigured()) {
      res.status(200).json({
        configured: false,
        state: "idle",
        callType: callType ?? "default",
        callId
      });
      return;
    }

    const snapshot = await deps.recordings.getSnapshot(callId);
    const withUrl = snapshot.assets.find((item) => typeof item.url === "string" && item.url.length > 0);
    orchestrator.updateRecordingMetadata(meetingId, {
      stream_call_id: snapshot.callId,
      stream_call_type: callType ?? snapshot.callType,
      stream_recording_state: snapshot.state,
      stream_recording_id: snapshot.activeRecordingId,
      stream_recording_url: withUrl?.url,
      stream_recording_filename: withUrl?.filename
    });
    const meta = orchestrator.getMeeting(meetingId).meeting.metadata ?? {};
    res.status(200).json({
      configured: true,
      ...snapshot,
      callType: callType ?? snapshot.callType,
      diagnostics: {
        streamRecordingUrl: typeof meta.stream_recording_url === "string" ? meta.stream_recording_url : null,
        recordingStartAttempts: typeof meta.stream_recording_start_attempts === "number" ? meta.stream_recording_start_attempts : null,
        lastRecordingError:
          typeof meta.stream_recording_last_error === "string"
            ? meta.stream_recording_last_error
            : typeof meta.stream_recording_error === "string"
              ? meta.stream_recording_error
              : null,
        recordingState: typeof meta.stream_recording_state === "string" ? meta.stream_recording_state : snapshot.state,
        agentHasAudio: typeof meta.agent_stream_has_audio === "boolean" ? meta.agent_stream_has_audio : null,
        agentHasVideo: typeof meta.agent_stream_has_video === "boolean" ? meta.agent_stream_has_video : null,
        candidateHasAudio: typeof meta.candidate_stream_has_audio === "boolean" ? meta.candidate_stream_has_audio : null,
        candidateHasVideo: typeof meta.candidate_stream_has_video === "boolean" ? meta.candidate_stream_has_video : null,
        agentAudioTrackMissingWarning:
          meta.agent_audio_track_missing_for_stream_recording === true
            ? "agent_audio_track_missing_for_stream_recording"
            : null
      }
    });
  }));

  router.post("/:meetingId/recording/start", asyncHandler(async (req: Request, res: Response) => {
    const meetingId = req.params.meetingId;
    orchestrator.getMeeting(meetingId);
    const input = parseBody(recordingStartSchema, req.body ?? {});
    const callId = input.callId ?? meetingId;
    if (!deps?.recordings || !deps.recordings.isConfigured()) {
      throw new HttpError(503, "Stream recording is not configured");
    }
    const snapshot = await deps.recordings.start(callId);
    orchestrator.updateRecordingMetadata(meetingId, {
      stream_call_id: snapshot.callId,
      stream_call_type: input.callType ?? snapshot.callType,
      stream_recording_state: snapshot.state,
      stream_recording_id: snapshot.activeRecordingId
    });
    res.status(202).json({ configured: true, ...snapshot, callType: input.callType ?? snapshot.callType });
  }));

  router.post("/:meetingId/recording/stop", asyncHandler(async (req: Request, res: Response) => {
    const meetingId = req.params.meetingId;
    orchestrator.getMeeting(meetingId);
    const input = parseBody(recordingStartSchema, req.body ?? {});
    const callId = input.callId ?? meetingId;
    if (!deps?.recordings || !deps.recordings.isConfigured()) {
      throw new HttpError(503, "Stream recording is not configured");
    }
    const snapshot = await deps.recordings.stop(callId);
    const withUrl = snapshot.assets.find((item) => typeof item.url === "string" && item.url.length > 0);
    orchestrator.updateRecordingMetadata(meetingId, {
      stream_call_id: snapshot.callId,
      stream_call_type: input.callType ?? snapshot.callType,
      stream_recording_state: snapshot.state,
      stream_recording_id: snapshot.activeRecordingId,
      stream_recording_url: withUrl?.url,
      stream_recording_filename: withUrl?.filename
    });
    res.status(202).json({ configured: true, ...snapshot, callType: input.callType ?? snapshot.callType });
  }));

  router.get("/:meetingId/recording/download", asyncHandler(async (req: Request, res: Response) => {
    const meetingId = req.params.meetingId;
    orchestrator.getMeeting(meetingId);
    const callId = typeof req.query.callId === "string" && req.query.callId.trim().length > 0
      ? req.query.callId.trim()
      : meetingId;
    if (!deps?.recordings || !deps.recordings.isConfigured()) {
      throw new HttpError(503, "Stream recording is not configured");
    }
    const snapshot = await deps.recordings.getSnapshot(callId);
    const asset = snapshot.assets.find((item) => typeof item.url === "string" && item.url.length > 0);
    if (!asset?.url) {
      res.status(202).json({
        state: snapshot.state,
        callType: snapshot.callType,
        callId: snapshot.callId,
        ready: false,
        message: "Recording is processing. Retry download shortly."
      });
      return;
    }
    res.status(200).json({
      state: snapshot.state,
      callType: snapshot.callType,
      callId: snapshot.callId,
      asset
    });
  }));

  router.post("/:meetingId/recording/sync-jobai", asyncHandler(async (req: Request, res: Response) => {
    const meetingId = req.params.meetingId;
    orchestrator.getMeeting(meetingId);
    const input = parseBody(recordingSyncSchema, req.body ?? {});
    const callId = input.callId ?? meetingId;
    if (!deps?.recordings || !deps.recordings.isConfigured()) {
      throw new HttpError(503, "Stream recording is not configured");
    }
    if (!deps.interviews) {
      throw new HttpError(503, "Interview sync service is not configured");
    }
    const snapshot = await deps.recordings.getSnapshot(callId);
    const latest = snapshot.assets.find((asset) => Boolean(asset.url));
    const recording = deps.interviews.attachRecording(input.jobAiId, {
      state: snapshot.state,
      callType: input.callType ?? snapshot.callType,
      callId: snapshot.callId,
      activeRecordingId: snapshot.activeRecordingId,
      latestDownloadUrl: latest?.url,
      latestFilename: latest?.filename,
      codec: latest?.codec,
      container: latest?.container
    });
    logger.info(
      {
        meetingId,
        jobAiId: input.jobAiId,
        recordingState: snapshot.state,
        callId: snapshot.callId
      },
      "jobai recording sync projected in interview store"
    );
    res.status(200).json({
      ok: true,
      projection: recording.projection.recording,
      snapshot
    });
  }));

  router.use(((error: unknown, _req: Request, _res: Response, next: express.NextFunction) => {
    if (error instanceof StreamRecordingStateError) {
      if (error.code === "processing") {
        next(new HttpError(202, error.message, { code: error.code }));
        return;
      }
      if (error.code === "not_recording" || error.code === "already_recording") {
        next(new HttpError(409, error.message, { code: error.code }));
        return;
      }
      if (error.code === "not_found") {
        next(new HttpError(404, error.message, { code: error.code }));
        return;
      }
    }
    next(error);
  }) as express.ErrorRequestHandler);

  return router;
}
