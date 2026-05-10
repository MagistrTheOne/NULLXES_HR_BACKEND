import type { MinimalRedisClient } from "./redisClient";

function heartbeatKey(prefix: string): string {
  return `${prefix}:avatar-gen:worker:last-success`;
}

export async function recordAvatarGenerateSuccess(
  redis: MinimalRedisClient | undefined,
  prefix: string,
  ttlMs: number
): Promise<void> {
  if (!redis) return;
  const iso = new Date().toISOString();
  await redis.set(heartbeatKey(prefix), iso, ttlMs).catch(() => undefined);
}

export async function readLastSuccessfulGenerationAt(
  redis: MinimalRedisClient | undefined,
  prefix: string
): Promise<string | null> {
  if (!redis) return null;
  const v = await redis.get(heartbeatKey(prefix)).catch(() => null);
  return v && typeof v === "string" ? v : null;
}
