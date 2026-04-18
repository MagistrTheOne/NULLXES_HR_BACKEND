import { env } from "../config/env";
import { logger } from "../logging/logger";
import { InMemoryInterviewStore } from "./interviewStore";
import { InMemoryMeetingStore } from "./meetingStore";
import { InMemorySessionStore } from "./sessionStore";
import { PersistedInterviewStore } from "./persistedInterviewStore";
import { PersistedMeetingStore } from "./persistedMeetingStore";
import { PersistedSessionStore } from "./persistedSessionStore";
import { MinimalRedisClient } from "./redisClient";

export interface StorageBackends {
  sessionStore: InMemorySessionStore;
  meetingStore: InMemoryMeetingStore;
  interviewStore: InMemoryInterviewStore;
  redis?: MinimalRedisClient;
  /** Метрика: количество reconnect-ов Redis (растёт монотонно). */
  redisReconnects(): number;
  close(): Promise<void>;
}

export async function createStorageBackends(): Promise<StorageBackends> {
  if (env.STORAGE_BACKEND === "memory" || !env.REDIS_URL) {
    logger.info({ backend: "memory" }, "storage backend initialized");
    const sessionStore = new InMemorySessionStore(env.SESSION_IDLE_TIMEOUT_MS, env.SESSION_SWEEP_INTERVAL_MS);
    const meetingStore = new InMemoryMeetingStore();
    const interviewStore = new InMemoryInterviewStore();
    return {
      sessionStore,
      meetingStore,
      interviewStore,
      redisReconnects: () => 0,
      close: async () => {}
    };
  }

  let reconnects = 0;
  const redis = new MinimalRedisClient({
    url: env.REDIS_URL,
    maxReconnectDelayMs: env.REDIS_RECONNECT_MAX_DELAY_MS,
    heartbeatMs: env.REDIS_HEARTBEAT_MS,
    commandQueueLimit: env.REDIS_COMMAND_QUEUE_LIMIT,
    onReconnect: () => {
      reconnects += 1;
    }
  });

  await redis.connect();
  logger.info({ backend: "redis", url: maskRedisUrl(env.REDIS_URL) }, "storage backend initialized");

  const sessionStore = new PersistedSessionStore({
    redis,
    prefix: env.REDIS_PREFIX,
    ttlMs: env.REDIS_SESSION_TTL_MS,
    idleTimeoutMs: env.SESSION_IDLE_TIMEOUT_MS,
    sweepIntervalMs: env.SESSION_SWEEP_INTERVAL_MS
  });
  const meetingStore = new PersistedMeetingStore({ redis, prefix: env.REDIS_PREFIX });
  const interviewStore = new PersistedInterviewStore({ redis, prefix: env.REDIS_PREFIX });

  await sessionStore.loadAll();
  await meetingStore.loadAll();
  await interviewStore.loadAll();

  return {
    sessionStore,
    meetingStore,
    interviewStore,
    redis,
    redisReconnects: () => reconnects,
    close: async () => {
      await redis.quit().catch(() => undefined);
    }
  };
}

function maskRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "[REDACTED]";
    }
    return parsed.toString();
  } catch {
    return "[invalid-redis-url]";
  }
}
