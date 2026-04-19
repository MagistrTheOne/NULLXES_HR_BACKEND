import express, { type Request, type Response } from "express";
import { z } from "zod";
import { logger } from "../logging/logger";
import { HttpError } from "../middleware/errorHandler";
import type { AvatarClient } from "../services/avatarClient";
import type { AvatarStateStore, AvatarPhase } from "../services/avatarStateStore";

/**
 * Endpoints consumed by the avatar pod (avatarservicenullxes on RunPod).
 *
 *   POST /avatar/events
 *     Bearer-auth callback fired by the pod for state changes:
 *     - avatar_ready (warmup complete, video track is publishing)
 *     - transcript_delta / transcript_completed / response_done (passthrough)
 *     - error / stopped (pod is tearing down)
 *
 *   GET /avatar/state/:meetingId
 *     Read endpoint for the frontend (and for /meetings/:meetingId enrichment)
 *     so the candidate sees "Подключаемся…" → "В эфире" without polling the pod.
 */

const POD_EVENT_TYPES = [
  "avatar_ready",
  "transcript_delta",
  "transcript_completed",
  "response_done",
  "error",
  "stopped"
] as const;

const eventSchema = z.object({
  type: z.enum(POD_EVENT_TYPES),
  session_id: z.string().min(1),
  meeting_id: z.string().min(1),
  ts: z.number().nonnegative().optional(),
  data: z.record(z.unknown()).optional()
});

function eventTypeToPhase(type: (typeof POD_EVENT_TYPES)[number]): AvatarPhase {
  switch (type) {
    case "avatar_ready":
      return "ready";
    case "transcript_delta":
      return "transcript_delta";
    case "transcript_completed":
      return "transcript_completed";
    case "response_done":
      return "response_done";
    case "stopped":
      return "stopped";
    case "error":
      return "failed";
  }
}

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

export interface AvatarRouterDeps {
  avatarClient: AvatarClient;
  stateStore: AvatarStateStore;
}

export function createAvatarRouter(deps: AvatarRouterDeps): express.Router {
  const router = express.Router();

  router.post(
    "/events",
    asyncHandler(async (req: Request, res: Response) => {
      if (!deps.avatarClient.verifyCallbackToken(req.header("authorization"))) {
        throw new HttpError(401, "Invalid or missing avatar callback bearer token");
      }

      const parsed = eventSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, "Invalid avatar event payload", parsed.error.flatten());
      }

      const event = parsed.data;
      const phase = eventTypeToPhase(event.type);
      const lastError =
        event.type === "error" && typeof event.data?.message === "string"
          ? (event.data.message as string)
          : undefined;

      const updated = deps.stateStore.recordEvent(event.meeting_id, {
        sessionId: event.session_id,
        phase,
        lastError
      });

      logger.info(
        {
          requestId: req.requestId,
          meetingId: event.meeting_id,
          sessionId: event.session_id,
          eventType: event.type,
          phase,
          known: Boolean(updated)
        },
        "avatar pod event received"
      );

      res.status(202).json({
        accepted: true,
        meetingId: event.meeting_id,
        sessionId: event.session_id,
        phase,
        avatarReady: updated?.avatarReady ?? false
      });
    })
  );

  router.get(
    "/state/:meetingId",
    (req: Request, res: Response) => {
      const meetingId = req.params.meetingId;
      const state = deps.stateStore.get(meetingId);
      if (!state) {
        res.status(200).json({
          meetingId,
          phase: "unknown",
          avatarReady: false,
          enabled: deps.avatarClient.enabled
        });
        return;
      }
      res.status(200).json({
        meetingId,
        sessionId: state.sessionId,
        agentUserId: state.agentUserId,
        phase: state.phase,
        avatarReady: state.avatarReady,
        startedAt: state.startedAt,
        lastEventAt: state.lastEventAt,
        lastError: state.lastError,
        enabled: deps.avatarClient.enabled
      });
    }
  );

  return router;
}
