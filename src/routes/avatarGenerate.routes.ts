import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { env, resolveGetstreamApiCredentials } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { logger } from "../logging/logger";
import { readLastSuccessfulGenerationAt } from "../services/avatarGenerateHeartbeat";
import { AvatarGenerateJobStore } from "../services/avatarGenerateJobStore";
import { AvatarGenerateRunpodService, type UploadedGenerateFiles } from "../services/avatarGenerateRunpodService";
import { startAvatarGenerateStaleSweeper } from "../services/avatarGenerateStaleJobSweeper";
import type { MinimalRedisClient } from "../services/redisClient";
import { ArachneAvatarFramesClient } from "../services/arachneAvatarFramesClient";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 2,
    fileSize: 20 * 1024 * 1024
  }
});

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

async function redisReachable(redis?: MinimalRedisClient): Promise<boolean> {
  if (!redis) return false;
  try {
    const pong = await redis.ping();
    return typeof pong === "string" && pong.toUpperCase() === "PONG";
  } catch {
    return false;
  }
}

export function createAvatarGenerateRouter(deps: { redis?: MinimalRedisClient }): express.Router {
  const router = express.Router();

  const jobStore = new AvatarGenerateJobStore({
    redis: deps.redis,
    prefix: env.REDIS_PREFIX,
    ttlMs: env.AVATAR_GENERATE_JOB_TTL_MS
  });

  const runpodUrl = env.RUNPOD_RUNTIME_URL?.trim() || env.AVATAR_POD_URL?.trim();
  const runpodService = runpodUrl
    ? new AvatarGenerateRunpodService({
        jobStore,
        runpodBaseUrl: runpodUrl,
        generateTimeoutMs: env.RUNPOD_GENERATE_TIMEOUT_MS,
        wallClockMs: env.AVATAR_GENERATE_WALL_MS,
        retryBackoffMs: [env.AVATAR_GENERATE_RETRY_BACKOFF_1_MS, env.AVATAR_GENERATE_RETRY_BACKOFF_2_MS],
        redis: deps.redis,
        redisPrefix: env.REDIS_PREFIX,
        heartbeatTtlMs: env.AVATAR_GENERATE_JOB_TTL_MS
      })
    : null;
  const arachneFramesClient = new ArachneAvatarFramesClient();

  startAvatarGenerateStaleSweeper({
    jobStore,
    staleMs: env.AVATAR_GENERATE_PROCESSING_STALE_MS,
    intervalMs: env.AVATAR_GENERATE_STALE_SWEEP_INTERVAL_MS
  });

  router.get(
    "/health",
    asyncHandler(async (_req: Request, res: Response) => {
      const streamCreds = resolveGetstreamApiCredentials();
      const streamConfigured = Boolean(streamCreds.apiKey && streamCreds.apiSecret);
      const redisOk = await redisReachable(deps.redis);

      let gpuReachable = false;
      let runtimeLatencyMs: number | null = null;

      if (runpodService && runpodUrl) {
        const probe = await runpodService.probeHealth();
        gpuReachable = probe.ok;
        runtimeLatencyMs = typeof probe.latencyMs === "number" && Number.isFinite(probe.latencyMs) ? probe.latencyMs : null;
      }

      const arachneProbe = await arachneFramesClient.probeHealth();
      const arachneWorkerReachable = arachneProbe.ok;
      const arachneWorkerLatencyMs =
        typeof arachneProbe.latencyMs === "number" && Number.isFinite(arachneProbe.latencyMs)
          ? arachneProbe.latencyMs
          : null;

      const lastSuccessfulGenerationAt = await readLastSuccessfulGenerationAt(deps.redis, env.REDIS_PREFIX);

      res.status(200).json({
        gpuReachable,
        redisReachable: redisOk,
        streamConfigured,
        runtimeLatencyMs,
        arachneWorkerReachable,
        arachneWorkerLatencyMs,
        engine: arachneProbe.engine,
        lastError: arachneProbe.lastError,
        lastSuccessfulGenerationAt
      });
    })
  );

  router.post(
    "/generate",
    upload.fields([
      { name: "image", maxCount: 1 },
      { name: "audio", maxCount: 1 }
    ]),
    asyncHandler(async (req: Request, res: Response) => {
      if (!runpodService || !runpodUrl) {
        throw new HttpError(503, "RUNPOD_RUNTIME_URL is not configured");
      }

      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const image = files?.image?.[0];
      const audio = files?.audio?.[0];
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";

      if (!image || !audio) {
        throw new HttpError(400, "multipart fields image and audio are required");
      }

      const payload: UploadedGenerateFiles = {
        image: {
          buffer: image.buffer,
          mimetype: image.mimetype,
          originalname: image.originalname
        },
        audio: {
          buffer: audio.buffer,
          mimetype: audio.mimetype,
          originalname: audio.originalname
        },
        prompt
      };

      const validation = runpodService.validateUploads(payload);
      if (!validation.ok) {
        throw new HttpError(400, validation.message);
      }

      try {
        const { jobId } = await runpodService.enqueue(payload);
        res.status(202).json({ jobId, state: "queued" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "enqueue_failed";
        logger.warn({ err, message }, "avatar generate enqueue failed");
        throw new HttpError(400, message);
      }
    })
  );

  router.get(
    "/job/:id",
    asyncHandler(async (req: Request, res: Response) => {
      const job = await jobStore.get(req.params.id);
      if (!job) {
        throw new HttpError(404, "job_not_found");
      }
      res.status(200).json({ job });
    })
  );

  router.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: "PayloadTooLarge",
          message: "upload exceeds maximum allowed size",
          requestId: req.requestId
        });
        return;
      }
      res.status(400).json({
        error: "BadRequest",
        message: err.message,
        requestId: req.requestId
      });
      return;
    }
    next(err);
  });

  return router;
}
