import express, { type Request, type Response } from "express";
import { z } from "zod";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";
import type { RuntimeEventStore } from "../services/runtimeEventStore";

/**
 * Orchestrated realtime endpoints (gateway-terminated OpenAI + mic ingest).
 *
 * Frontend sends mic PCM16 to the gateway; the gateway is responsible for:
 * - maintaining an authoritative OpenAI Realtime session,
 * - routing audio to the inference worker,
 * - publishing agent audio/video to Stream.
 *
 * This router intentionally keeps the HTTP surface minimal and stable.
 */

export interface OrchestratedRealtimeRouterDeps {
  runtimeEvents?: RuntimeEventStore;
}

const startSchema = z.object({
  meetingId: z.string().min(1),
  sessionId: z.string().min(1),
  sampleRateHz: z.number().int().positive().default(16000)
});

const appendSchema = z.object({
  meetingId: z.string().min(1),
  /** base64 PCM16 LE samples. */
  pcm16: z.string().min(1),
  timestampMs: z.number().int().nonnegative().optional()
});

export function createOrchestratedRealtimeRouter(
  deps: OrchestratedRealtimeRouterDeps
): express.Router {
  const router = express.Router();

  router.post("/orchestrated/start", (req: Request, res: Response) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid start payload", parsed.error.flatten());
    }
    const { meetingId, sessionId, sampleRateHz } = parsed.data;
    void deps.runtimeEvents?.append({
      type: "realtime.orchestrated.started",
      meetingId,
      sessionId,
      actor: "frontend",
      payload: { sampleRateHz }
    }).catch(() => undefined);
    logger.info({ meetingId, sessionId, sampleRateHz }, "orchestrated realtime start requested");
    res.status(202).json({ accepted: true, meetingId, sessionId });
  });

  router.post("/orchestrated/mic/append", (req: Request, res: Response) => {
    const parsed = appendSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid mic append payload", parsed.error.flatten());
    }
    const { meetingId, pcm16, timestampMs } = parsed.data;
    void deps.runtimeEvents?.append({
      type: "realtime.mic.append",
      meetingId,
      sessionId: undefined,
      actor: "frontend",
      payload: { bytes: Math.floor((pcm16.length * 3) / 4), timestampMs: timestampMs ?? Date.now() }
    }).catch(() => undefined);
    res.status(202).json({ accepted: true, meetingId });
  });

  return router;
}

