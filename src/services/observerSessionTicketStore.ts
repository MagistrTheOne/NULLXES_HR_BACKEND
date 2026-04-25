import { logger } from "../logging/logger";
import type { MinimalRedisClient } from "./redisClient";

export interface ObserverSessionTicketStore {
  consumeOnce(jti: string, exp: number): Promise<boolean>;
}

export class InMemoryObserverSessionTicketStore implements ObserverSessionTicketStore {
  private readonly consumed = new Map<string, number>();

  async consumeOnce(jti: string, exp: number): Promise<boolean> {
    this.gc();
    const existingExp = this.consumed.get(jti);
    if (typeof existingExp === "number" && existingExp > Date.now()) {
      return false;
    }
    this.consumed.set(jti, exp);
    return true;
  }

  private gc(): void {
    const now = Date.now();
    for (const [jti, exp] of this.consumed) {
      if (exp <= now) {
        this.consumed.delete(jti);
      }
    }
  }
}

interface RedisObserverSessionTicketStoreOptions {
  redis: MinimalRedisClient;
  prefix: string;
}

export class RedisObserverSessionTicketStore implements ObserverSessionTicketStore {
  private readonly redis: MinimalRedisClient;
  private readonly prefix: string;

  constructor(options: RedisObserverSessionTicketStoreOptions) {
    this.redis = options.redis;
    this.prefix = options.prefix;
  }

  async consumeOnce(jti: string, exp: number): Promise<boolean> {
    const ttlMs = Math.max(1000, exp - Date.now());
    try {
      return await this.redis.setIfAbsent(this.consumeKey(jti), "1", ttlMs);
    } catch (err) {
      logger.error(
        { err: (err as Error).message, jti },
        "observer session ticket consume failed"
      );
      return false;
    }
  }

  private consumeKey(jti: string): string {
    return `${this.prefix}:observer_ticket:consumed:${jti}`;
  }
}

