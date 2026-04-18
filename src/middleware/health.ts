import type { Request, Response } from "express";
import { env } from "../config/env";
import type { MinimalRedisClient } from "../services/redisClient";
import type { WebhookOutbox } from "../services/webhookOutbox";

interface ReadinessDeps {
  redis?: MinimalRedisClient;
  redisReconnects: () => number;
  webhookOutbox: WebhookOutbox;
  hasOpenAIKey: boolean;
}

export function createReadinessHandler(deps: ReadinessDeps) {
  return async function readinessHandler(_req: Request, res: Response): Promise<void> {
    const checks: Record<string, unknown> = {
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString(),
      storageBackend: env.STORAGE_BACKEND,
      openai: deps.hasOpenAIKey ? "ok" : "missing"
    };

    let healthy = deps.hasOpenAIKey;

    if (env.STORAGE_BACKEND === "redis" && deps.redis) {
      const redisOk = await pingRedis(deps.redis);
      checks.redis = redisOk ? "ok" : "down";
      checks.redisReconnects = deps.redisReconnects();
      if (!redisOk) {
        healthy = false;
      }
    } else {
      checks.redis = "disabled";
    }

    const stats = deps.webhookOutbox.getStats();
    checks.webhookOutbox = stats;

    res.status(healthy ? 200 : 503).json(checks);
  };
}

async function pingRedis(redis: MinimalRedisClient): Promise<boolean> {
  if (!redis.isConnected()) return false;
  try {
    const reply = await redis.ping();
    return typeof reply === "string" && reply.toUpperCase().includes("PONG");
  } catch {
    return false;
  }
}
