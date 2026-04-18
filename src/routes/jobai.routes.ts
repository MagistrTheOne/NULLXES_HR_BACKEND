import express, { type Request, type Response } from "express";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import { InterviewSyncService } from "../services/interviewSyncService";

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function readIngestSecretFromRequest(req: Request): string | undefined {
  const auth = req.header("authorization") ?? req.header("Authorization");
  if (auth) {
    const trimmed = auth.trim();
    const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
    if (bearer?.[1]) {
      return bearer[1].trim();
    }
    return trimmed;
  }
  return req.header("x-jobai-ingest-secret") ?? undefined;
}

function assertIngestSecret(req: Request): void {
  if (!env.JOBAI_INGEST_SECRET) {
    return;
  }

  const provided = readIngestSecretFromRequest(req);
  if (provided !== env.JOBAI_INGEST_SECRET) {
    throw new HttpError(401, "Invalid ingest secret");
  }
}

export function createJobAiRouter(service: InterviewSyncService): express.Router {
  const router = express.Router();

  router.post("/webhooks/jobai/interviews", asyncHandler(async (req: Request, res: Response) => {
    assertIngestSecret(req);
    const stored = await service.ingestWebhook(req.body);
    res.status(202).json({
      interview: stored.rawPayload,
      projection: stored.projection,
      // Relative links for JobAI UI: base URL is resolved on caller side.
      candidateUrl: stored.projection.candidateEntryPath,
      spectatorUrl: stored.projection.spectatorEntryPath
    });
  }));

  router.post("/jobai/sync", asyncHandler(async (req: Request, res: Response) => {
    const skip = typeof req.body?.skip === "number" ? req.body.skip : 0;
    const take = typeof req.body?.take === "number" ? req.body.take : 20;
    const result = await service.synchronize(skip, take);
    res.status(200).json(result);
  }));

  return router;
}
