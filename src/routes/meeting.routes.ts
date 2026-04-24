import express, { type Request, type Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";
import { MeetingOrchestrator } from "../services/meetingOrchestrator";
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

export function createMeetingRouter(orchestrator: MeetingOrchestrator): express.Router {
  const router = express.Router();

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

  return router;
}
