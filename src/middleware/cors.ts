import cors, { type CorsOptions } from "cors";
import type { RequestHandler } from "express";
import { env } from "../config/env";

function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function createCorsMiddleware(): RequestHandler {
  const allowed = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
  const allowAll = allowed.length === 0 || allowed.includes("*");

  const options: CorsOptions = {
    methods: ["GET", "POST", "DELETE", "PATCH", "OPTIONS"],
    credentials: false,
    maxAge: 600,
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowAll) {
        callback(null, true);
        return;
      }
      if (allowed.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS policy`));
    }
  };

  return cors(options);
}
