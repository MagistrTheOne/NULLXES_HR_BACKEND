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
      "headers.authorization",
      "*.apiKey",
      "*.token",
      "*.secret",
      "openaiApiKey"
    ],
    censor: "[REDACTED]"
  }
});
