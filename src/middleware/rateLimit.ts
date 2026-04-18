import type { NextFunction, Request, Response } from "express";
import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import { env } from "../config/env";

const DISABLED_HANDLER: RateLimitRequestHandler = ((
  _req: Request,
  _res: Response,
  next: NextFunction
) => next()) as unknown as RateLimitRequestHandler;

interface LimiterOptions {
  windowMs: number;
  max: number;
  name: string;
}

function buildLimiter(options: LimiterOptions): RateLimitRequestHandler {
  if (!env.RATE_LIMIT_ENABLED) {
    return DISABLED_HANDLER;
  }
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "RateLimited",
      message: `Rate limit exceeded for ${options.name}. Try again later.`
    }
  });
}

export const realtimeSessionLimiter = buildLimiter({ windowMs: 60_000, max: 30, name: "realtime.session" });
export const realtimeTokenLimiter = buildLimiter({ windowMs: 60_000, max: 60, name: "realtime.token" });
export const admissionLimiter = buildLimiter({ windowMs: 60_000, max: 60, name: "meetings.admission" });
export const jobaiIngestLimiter = buildLimiter({ windowMs: 60_000, max: 120, name: "jobai.ingest" });
