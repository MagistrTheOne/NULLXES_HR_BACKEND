import { logger } from "../logging/logger";
import type { MinimalRedisClient } from "./redisClient";
import { AvatarStateStore, type AvatarState } from "./avatarStateStore";

interface PersistedAvatarStateStoreOptions {
  redis: MinimalRedisClient;
  prefix: string;
  /** TTL for avatar state keys in ms. */
  ttlMs: number;
}

/**
 * Per-key Redis persistence for avatar state.
 *
 * Key format: `${prefix}:avatar:${meetingId}`
 *
 * This mirrors the per-key strategy used by PersistedSessionStore to avoid
 * blob rewrites. The goal is operational: survive gateway restarts so UI
 * can still show last known avatar speaker/degradation without waiting for
 * callbacks.
 */
export class PersistedAvatarStateStore extends AvatarStateStore {
  private readonly redis: MinimalRedisClient;
  private readonly prefix: string;
  private readonly ttlMs: number;

  constructor(options: PersistedAvatarStateStoreOptions) {
    super();
    this.redis = options.redis;
    this.prefix = options.prefix;
    this.ttlMs = options.ttlMs;
  }

  async loadAll(): Promise<void> {
    const pattern = `${this.prefix}:avatar:*`;
    const keys = await this.redis.scanAll(pattern, 200);
    let restored = 0;
    for (const key of keys) {
      try {
        const payload = await this.redis.get(key);
        if (!payload) continue;
        const record = JSON.parse(payload) as AvatarState;
        if (record && typeof record.meetingId === "string") {
          this.hydrate(record);
          restored += 1;
        }
      } catch (error) {
        logger.warn({ key, err: error }, "failed to hydrate avatar state from redis");
      }
    }
    if (restored > 0) {
      logger.info({ restored }, "hydrated avatar states from redis");
    }
  }

  override upsertStart(meetingId: string, sessionId: string, agentUserId: string): void {
    super.upsertStart(meetingId, sessionId, agentUserId);
    const state = this.get(meetingId);
    if (state) void this.persist(state);
  }

  override recordEvent(
    meetingId: string,
    update: { sessionId: string; phase: AvatarState["phase"]; lastError?: string }
  ): AvatarState | null {
    const state = super.recordEvent(meetingId, update);
    if (state) void this.persist(state);
    return state;
  }

  override patch(
    meetingId: string,
    patch: Partial<Omit<AvatarState, "meetingId">> & { sessionId: string }
  ): AvatarState | null {
    const state = super.patch(meetingId, patch);
    if (state) void this.persist(state);
    return state;
  }

  override remove(meetingId: string): void {
    super.remove(meetingId);
    void this.redis.del(this.keyFor(meetingId)).catch(() => undefined);
  }

  private hydrate(state: AvatarState): void {
    this.setInternal(state.meetingId, state);
  }

  private async persist(state: AvatarState): Promise<void> {
    try {
      await this.redis.set(this.keyFor(state.meetingId), JSON.stringify(state), this.ttlMs);
    } catch (error) {
      logger.warn({ err: error, meetingId: state.meetingId }, "failed to persist avatar state to redis");
    }
  }

  private keyFor(meetingId: string): string {
    return `${this.prefix}:avatar:${meetingId}`;
  }
}

