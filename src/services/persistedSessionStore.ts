import { logger } from "../logging/logger";
import type { DataChannelEventPayload, SessionRecord, SessionStatus } from "../types/realtime";
import type { MinimalRedisClient } from "./redisClient";
import { InMemorySessionStore } from "./sessionStore";

interface PersistedSessionStoreOptions {
  redis: MinimalRedisClient;
  prefix: string;
  ttlMs: number;
  idleTimeoutMs: number;
  sweepIntervalMs: number;
}

/**
 * Per-key обёртка над InMemorySessionStore.
 * Каждое мутирующее действие переписывает один ключ Redis (SET PX ttl), а не блоб со всеми сессиями.
 * При старте — SCAN MATCH prefix:session:* и hydrate.
 */
export class PersistedSessionStore extends InMemorySessionStore {
  private readonly redis: MinimalRedisClient;
  private readonly prefix: string;
  private readonly ttlMs: number;

  constructor(options: PersistedSessionStoreOptions) {
    super(options.idleTimeoutMs, options.sweepIntervalMs);
    this.redis = options.redis;
    this.prefix = options.prefix;
    this.ttlMs = options.ttlMs;
  }

  async loadAll(): Promise<void> {
    const pattern = `${this.prefix}:session:*`;
    const keys = await this.redis.scanAll(pattern, 200);
    let restored = 0;
    for (const key of keys) {
      try {
        const payload = await this.redis.get(key);
        if (!payload) continue;
        const record = JSON.parse(payload) as SessionRecord;
        if (record && typeof record.id === "string") {
          this.hydrate(record);
          restored += 1;
        }
      } catch (error) {
        logger.warn({ key, err: error }, "failed to hydrate session record from redis");
      }
    }
    if (restored > 0) {
      logger.info({ restored }, "hydrated sessions from redis");
    }

    // legacy migration: один блобный ключ ${prefix}:sessions, если был.
    const legacyKey = `${this.prefix}:sessions`;
    try {
      const legacyPayload = await this.redis.get(legacyKey);
      if (legacyPayload) {
        const legacyRecords = JSON.parse(legacyPayload) as SessionRecord[];
        if (Array.isArray(legacyRecords)) {
          for (const record of legacyRecords) {
            if (record?.id) {
              this.hydrate(record);
              await this.persist(record);
            }
          }
        }
        await this.redis.del(legacyKey);
        logger.info({ migrated: legacyRecords.length }, "migrated legacy session blob to per-key keys");
      }
    } catch (error) {
      logger.warn({ err: error }, "legacy session blob migration skipped");
    }
  }

  override createSession(sessionId: string): SessionRecord {
    const record = super.createSession(sessionId);
    void this.persist(record);
    return record;
  }

  override patchSession(sessionId: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    const record = super.patchSession(sessionId, patch);
    if (record) {
      void this.persist(record);
    }
    return record;
  }

  override updateStatus(sessionId: string, status: SessionStatus): SessionRecord | undefined {
    return this.patchSession(sessionId, { status });
  }

  override markError(sessionId: string, message: string): SessionRecord | undefined {
    return this.patchSession(sessionId, { status: "error", lastError: message });
  }

  override touch(sessionId: string): void {
    super.touch(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      void this.persist(session);
    }
  }

  override registerEvent(sessionId: string, event: DataChannelEventPayload): SessionRecord | undefined {
    const record = super.registerEvent(sessionId, event);
    if (record) {
      void this.persist(record);
    }
    return record;
  }

  private async persist(record: SessionRecord): Promise<void> {
    try {
      await this.redis.set(this.keyFor(record.id), JSON.stringify(record), this.ttlMs);
    } catch (error) {
      logger.warn({ err: error, sessionId: record.id }, "failed to persist session to redis");
    }
  }

  private keyFor(sessionId: string): string {
    return `${this.prefix}:session:${sessionId}`;
  }
}
