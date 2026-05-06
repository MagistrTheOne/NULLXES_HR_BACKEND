import express, { type Request, type Response } from "express";
import { z } from "zod";
import { logger } from "../logging/logger";
import { HttpError } from "../middleware/errorHandler";
import type { AvatarClient } from "../services/avatarClient";
import type { AvatarStateStore, AvatarPhase } from "../services/avatarStateStore";
import type { MeetingOrchestrator } from "../services/meetingOrchestrator";
import type { RuntimeEventStore } from "../services/runtimeEventStore";

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
  "speaker_changed",
  "engine_degraded",
  "telemetry",
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
    case "speaker_changed":
    case "engine_degraded":
    case "telemetry":
      return "starting";
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
  meetingOrchestrator: MeetingOrchestrator;
  runtimeEvents?: RuntimeEventStore;
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

      const telemetryPatch: {
        videoModel?: "wan" | "ltx" | "echomimic";
        clipLatencyMs?: number;
        bufferSeconds?: number;
        droppedFrames?: number;
        gpuConnected?: boolean;
        queueDepth?: number;
        gpuMemoryMb?: number;
      } | null =
        event.type === "telemetry" || event.type === "engine_degraded" || event.type === "speaker_changed" || event.type === "avatar_ready"
          ? {
              videoModel:
                event.data?.model === "echomimic"
                  ? "echomimic"
                  : event.data?.model === "ltx"
                    ? "ltx"
                    : event.data?.model === "wan"
                      ? "wan"
                      : undefined,
              clipLatencyMs: typeof event.data?.clip_latency_ms === "number" ? (event.data.clip_latency_ms as number) : undefined,
              bufferSeconds: typeof event.data?.buffer_seconds === "number" ? (event.data.buffer_seconds as number) : undefined,
              droppedFrames: typeof event.data?.dropped_frames === "number" ? (event.data.dropped_frames as number) : undefined
              ,
              gpuConnected: typeof event.data?.gpu_connected === "boolean" ? (event.data.gpu_connected as boolean) : undefined,
              queueDepth: typeof event.data?.queue_depth === "number" ? (event.data.queue_depth as number) : undefined,
              gpuMemoryMb: typeof event.data?.gpu_memory_mb === "number" ? (event.data.gpu_memory_mb as number) : undefined
            }
          : null;

      const updated =
        event.type === "speaker_changed"
          ? deps.stateStore.patch(event.meeting_id, {
              sessionId: event.session_id,
              ...(telemetryPatch ? telemetryPatch : {}),
              activeSpeaker:
                event.data?.active_speaker === "candidate" ? "candidate" : event.data?.active_speaker === "assistant" ? "assistant" : undefined,
              videoAudioSource:
                event.data?.video_audio_source === "mic"
                  ? "mic"
                  : event.data?.video_audio_source === "tts"
                    ? "tts"
                    : event.data?.video_audio_source === "auto"
                      ? "auto"
                      : undefined
            })
          : event.type === "engine_degraded"
            ? deps.stateStore.patch(event.meeting_id, {
                sessionId: event.session_id,
                ...(telemetryPatch ? telemetryPatch : {}),
                degradationLevel:
                  event.data?.level === "hard"
                    ? "hard"
                    : event.data?.level === "soft"
                      ? "soft"
                      : event.data?.level === "fallback"
                        ? "fallback"
                        : "none"
              })
            : event.type === "telemetry"
              ? deps.stateStore.patch(event.meeting_id, {
                  sessionId: event.session_id,
                  ...(telemetryPatch ? telemetryPatch : {})
                })
            : deps.stateStore.recordEvent(event.meeting_id, {
                sessionId: event.session_id,
                phase,
                lastError
              });
      void deps.runtimeEvents?.append({
        type: "avatar.event",
        meetingId: event.meeting_id,
        sessionId: event.session_id,
        actor: "avatar.pod",
        payload: {
          eventType: event.type,
          phase,
          data: event.data ?? {},
          known: Boolean(updated)
        }
      }).catch(() => undefined);

      if (event.type === "response_done") {
        const sourceId =
          typeof event.data?.response_id === "string"
            ? (event.data.response_id as string)
            : typeof event.data?.responseId === "string"
              ? (event.data.responseId as string)
              : undefined;
        deps.meetingOrchestrator.advanceQuestionIndex(event.meeting_id, {
          actor: "avatar.pod",
          reason: "response_done",
          sourceId
        });
      }

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
        videoModel: state.videoModel,
        clipLatencyMs: state.clipLatencyMs,
        bufferSeconds: state.bufferSeconds,
        droppedFrames: state.droppedFrames,
        gpuConnected: state.gpuConnected,
        queueDepth: state.queueDepth,
        gpuMemoryMb: state.gpuMemoryMb,
        startedAt: state.startedAt,
        lastEventAt: state.lastEventAt,
        lastError: state.lastError,
        enabled: deps.avatarClient.enabled
      });
    }
  );

  return router;
}
