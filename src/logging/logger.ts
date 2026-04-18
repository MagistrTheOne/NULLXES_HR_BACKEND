import pino from "pino";
import { env } from "../config/env";

export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  base: {
    service: "realtime-webrtc-gateway"
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-jobai-secret']",
      "headers.authorization",
      "headers.cookie",
      "*.apiKey",
      "*.token",
      "*.secret",
      "*.password",
      "*.OPENAI_API_KEY",
      "*.JOBAI_API_TOKEN",
      "*.JOBAI_API_BASIC_PASSWORD",
      "*.JOBAI_WEBHOOK_SECRET",
      "*.JOBAI_INGEST_SECRET",
      "*.REDIS_URL",
      "openaiApiKey",
      "ephemeralToken",
      "rawPayload.headers.authorization"
    ],
    censor: "[REDACTED]"
  }
});
