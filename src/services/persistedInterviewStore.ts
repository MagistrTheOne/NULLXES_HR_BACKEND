import { logger } from "../logging/logger";
import type {
  InterviewProjection,
  JobAiInterview,
  PrototypeCandidateIdentity,
  StoredInterview
} from "../types/interview";
import { InMemoryInterviewStore } from "./interviewStore";
import type { MinimalRedisClient } from "./redisClient";

interface PersistedInterviewStoreOptions {
  redis: MinimalRedisClient;
  prefix: string;
}

export class PersistedInterviewStore extends InMemoryInterviewStore {
  private readonly redis: MinimalRedisClient;
  private readonly prefix: string;

  constructor(options: PersistedInterviewStoreOptions) {
    super();
    this.redis = options.redis;
    this.prefix = options.prefix;
  }

  async loadAll(): Promise<void> {
    const pattern = `${this.prefix}:interview:*`;
    const keys = await this.redis.scanAll(pattern, 200);
    let restored = 0;
    for (const key of keys) {
      try {
        const payload = await this.redis.get(key);
        if (!payload) continue;
        const record = JSON.parse(payload) as StoredInterview;
        if (record && typeof record.jobAiId === "number") {
          const changed = this.hydrate(record);
          if (changed) {
            await this.persistInterview(record.jobAiId);
          }
          restored += 1;
        }
      } catch (error) {
        logger.warn({ key, err: error }, "failed to hydrate interview record from redis");
      }
    }
    if (restored > 0) {
      logger.info({ restored }, "hydrated interviews from redis");
    }

    const syncKey = `${this.prefix}:interview-sync`;
    try {
      const payload = await this.redis.get(syncKey);
      if (payload) {
        const state = JSON.parse(payload) as {
          lastSyncAt: string | null;
          lastSyncResult: "idle" | "success" | "error";
          lastSyncError: string | null;
        };
        this.hydrateSyncState(state);
      }
    } catch (error) {
      logger.warn({ err: error }, "failed to hydrate interview sync state");
    }

    const legacyKey = `${this.prefix}:interviews`;
    try {
      const legacy = await this.redis.get(legacyKey);
      if (legacy) {
        const arr = JSON.parse(legacy) as StoredInterview[];
        if (Array.isArray(arr)) {
          for (const record of arr) {
            if (record?.jobAiId) {
              this.hydrate(record);
              await this.persistInterview(record.jobAiId);
            }
          }
        }
        await this.redis.del(legacyKey);
        logger.info({ migrated: arr.length }, "migrated legacy interview blob to per-key keys");
      }
    } catch (error) {
      logger.warn({ err: error }, "legacy interview blob migration skipped");
    }
  }

  override upsert(rawPayload: JobAiInterview): StoredInterview {
    const record = super.upsert(rawPayload);
    void this.persistInterview(record.jobAiId);
    return record;
  }

  override setPrototypeIdentity(jobAiId: number, identity: PrototypeCandidateIdentity): StoredInterview {
    const record = super.setPrototypeIdentity(jobAiId, identity);
    void this.persistInterview(jobAiId);
    return record;
  }

  override clearPrototypeIdentity(jobAiId: number): StoredInterview {
    const record = super.clearPrototypeIdentity(jobAiId);
    void this.persistInterview(jobAiId);
    return record;
  }

  override setRuntimeSession(
    jobAiId: number,
    params: { meetingId: string; sessionId?: string; nullxesStatus?: InterviewProjection["nullxesStatus"] }
  ): StoredInterview {
    const record = super.setRuntimeSession(jobAiId, params);
    void this.persistInterview(jobAiId);
    return record;
  }

  override setSyncState(result: { status: "success" | "error"; error?: string }): void {
    super.setSyncState(result);
    void this.persistSyncState();
  }

  private async persistInterview(jobAiId: number): Promise<void> {
    const record = this.byJobAiId.get(jobAiId);
    if (!record) return;
    try {
      await this.redis.set(this.keyFor(jobAiId), JSON.stringify(record));
    } catch (error) {
      logger.warn({ err: error, jobAiId }, "failed to persist interview to redis");
    }
  }

  private async persistSyncState(): Promise<void> {
    try {
      await this.redis.set(
        `${this.prefix}:interview-sync`,
        JSON.stringify({
          lastSyncAt: this.lastSyncAt,
          lastSyncResult: this.lastSyncResult,
          lastSyncError: this.lastSyncError
        })
      );
    } catch (error) {
      logger.warn({ err: error }, "failed to persist interview sync state");
    }
  }

  private keyFor(jobAiId: number): string {
    return `${this.prefix}:interview:${jobAiId}`;
  }
}
