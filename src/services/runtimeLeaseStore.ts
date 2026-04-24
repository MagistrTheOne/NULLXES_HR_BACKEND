import type { MinimalRedisClient } from "./redisClient";

export interface RuntimeLeaseResult {
  acquired: boolean;
  resource: string;
  owner: string;
  expiresAtMs?: number;
  currentOwner?: string;
}

type LeaseRecord = {
  owner: string;
  expiresAtMs: number;
};

export class RuntimeLeaseStore {
  private readonly memory = new Map<string, LeaseRecord>();

  constructor(
    private readonly options?: {
      redis?: MinimalRedisClient;
      prefix?: string;
    }
  ) {}

  async acquire(resource: string, owner: string, ttlMs: number): Promise<RuntimeLeaseResult> {
    const now = Date.now();
    const expiresAtMs = now + ttlMs;
    const redis = this.options?.redis;
    if (redis) {
      const acquired = await redis.setIfAbsent(this.redisKey(resource), owner, ttlMs).catch(() => false);
      if (acquired) {
        return { acquired: true, resource, owner, expiresAtMs };
      }
      const currentOwner = await redis.get(this.redisKey(resource)).catch(() => null);
      return { acquired: false, resource, owner, currentOwner: currentOwner ?? undefined };
    }

    const current = this.memory.get(resource);
    if (!current || current.expiresAtMs <= now || current.owner === owner) {
      this.memory.set(resource, { owner, expiresAtMs });
      return { acquired: true, resource, owner, expiresAtMs };
    }
    return { acquired: false, resource, owner, currentOwner: current.owner };
  }

  async release(resource: string, owner: string): Promise<boolean> {
    const redis = this.options?.redis;
    if (redis) {
      const currentOwner = await redis.get(this.redisKey(resource)).catch(() => null);
      if (currentOwner !== owner) {
        return false;
      }
      await redis.del(this.redisKey(resource)).catch(() => undefined);
      return true;
    }
    const current = this.memory.get(resource);
    if (current?.owner !== owner) {
      return false;
    }
    this.memory.delete(resource);
    return true;
  }

  private redisKey(resource: string): string {
    return `${this.options?.prefix ?? "nullxes:hr-ai"}:lease:${resource}`;
  }
}
