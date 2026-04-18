import express, { type Request, type Response } from "express";
import { HttpError } from "../middleware/errorHandler";
import { InterviewSyncService } from "../services/interviewSyncService";
import { JobAiClient } from "../services/jobaiClient";

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: express.NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function parseIntegerParam(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new HttpError(400, `Invalid ${name}`);
  }
  return parsed;
}

export function createTzAliasRouter(service: InterviewSyncService, jobAiClient: JobAiClient): express.Router {
  const router = express.Router();

  router.get(
    "/questions/by_specialty/:id",
    asyncHandler(async (req: Request, res: Response) => {
      if (!jobAiClient.isConfigured()) {
        throw new HttpError(503, "JobAI API is not configured");
      }
      const id = parseIntegerParam(req.params.id, "specialty id");
      const payload = await jobAiClient.getSpecialty(id);
      res.status(200).json(payload);
    })
  );

  router.get("/questions/general", asyncHandler(async (_req: Request, res: Response) => {
    if (!jobAiClient.isConfigured()) {
      res.status(200).json({
        greetingSpeech: "",
        finalSpeech: "",
        source: "prototype_fallback"
      });
      return;
    }
    try {
      const payload = await jobAiClient.getSettings();
      res.status(200).json(payload);
    } catch {
      res.status(200).json({
        greetingSpeech: "",
        finalSpeech: "",
        source: "prototype_fallback"
      });
    }
  }));

  router.post(
    "/interviews/:id/cancel",
    asyncHandler(async (req: Request, res: Response) => {
      const id = parseIntegerParam(req.params.id, "interview id");
      try {
        const updated = await service.cancelInterview(id);
        res.status(200).json({
          interview: updated.rawPayload,
          projection: updated.projection
        });
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 400) {
          res.status(400).json({
            error: "cancel_failed",
            message: error.message,
            details: error.details
          });
          return;
        }
        throw error;
      }
    })
  );

  return router;
}
