import { logger } from "../logging/logger";
import type { MinimalRedisClient } from "./redisClient";
import type { JoinTokenRole } from "./joinTokenSigner";

/**
 * Audit + revocation store for M3 signed join links.
 *
 * Two responsibilities:
 *  - record every issued token (per interview, capped tail) for HR audit / revocation UI;
 *  - mark tokens as revoked by jti so the verifier can short-circuit them before TTL expiry.
 *
 * In-memory and Redis backends both implement this interface. In-memory is fine for
 * single-node gateway, Redis is used in production so revocations survive restarts and
 * audit history is shared between replicas.
 */

export interface JoinTokenAuditEntry {
  jti: string;
  jobAiId: number;
  role: JoinTokenRole;
  issuedAt: number;
  exp: number;
  ip?: string;
  displayName?: string;
  revokedAt?: number;
}

export interface JoinTokenStore {
  recordIssued(entry: JoinTokenAuditEntry): Promise<void>;
  revoke(jobAiId: number, jti: string, exp: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
  listAudit(jobAiId: number, limit?: number): Promise<JoinTokenAuditEntry[]>;
}

const DEFAULT_LIMIT = 20;

// ---------- in-memory ----------

export class InMemoryJoinTokenStore implements JoinTokenStore {
  private readonly auditByJobAiId = new Map<number, JoinTokenAuditEntry[]>();
  private readonly revoked = new Map<string, number>(); // jti -> exp ms

  constructor(private readonly capPerJobAiId: number = 100) {}

  async recordIssued(entry: JoinTokenAuditEntry): Promise<void> {
    const list = this.auditByJobAiId.get(entry.jobAiId) ?? [];
    list.unshift(entry);
    while (list.length > this.capPerJobAiId) {
      list.pop();
    }
    this.auditByJobAiId.set(entry.jobAiId, list);
  }

  async revoke(jobAiId: number, jti: string, exp: number): Promise<void> {
    this.revoked.set(jti, exp);
    this.gcRevoked();
    const list = this.auditByJobAiId.get(jobAiId);
    if (list) {
      const updated = list.map((entry) =>
        entry.jti === jti ? { ...entry, revokedAt: Date.now() } : entry
      );
      this.auditByJobAiId.set(jobAiId, updated);
    }
  }

  async isRevoked(jti: string): Promise<boolean> {
    const exp = this.revoked.get(jti);
    if (typeof exp !== "number") return false;
    if (exp <= Date.now()) {
      this.revoked.delete(jti);
      return false;
    }
    return true;
  }

  async listAudit(jobAiId: number, limit: number = DEFAULT_LIMIT): Promise<JoinTokenAuditEntry[]> {
    const list = this.auditByJobAiId.get(jobAiId) ?? [];
    return list.slice(0, Math.max(0, limit));
  }

  private gcRevoked(): void {
    const now = Date.now();
    for (const [jti, exp] of this.revoked) {
      if (exp <= now) {
        this.revoked.delete(jti);
      }
    }
  }
}

// ---------- redis-backed ----------

interface RedisJoinTokenStoreOptions {
  redis: MinimalRedisClient;
  prefix: string;
  capPerJobAiId?: number;
}

/**
 * Redis layout:
 *  - <prefix>:join_token:audit:<jobAiId>   = JSON array of JoinTokenAuditEntry, head=newest, capped
 *  - <prefix>:join_token:revoked:<jti>     = "1" with PX (exp - now)
 *
 * Audit is non-atomic (read-modify-write); fine for single gateway instance.
 * If you go multi-replica with concurrent issuance, swap to LPUSH/LTRIM via
 * MinimalRedisClient — this implementation keeps a small surface on purpose.
 */
export class RedisJoinTokenStore implements JoinTokenStore {
  private readonly redis: MinimalRedisClient;
  private readonly prefix: string;
  private readonly capPerJobAiId: number;

  constructor(options: RedisJoinTokenStoreOptions) {
    this.redis = options.redis;
    this.prefix = options.prefix;
    this.capPerJobAiId = options.capPerJobAiId ?? 100;
  }

  async recordIssued(entry: JoinTokenAuditEntry): Promise<void> {
    const key = this.auditKey(entry.jobAiId);
    const existing = await this.readAuditList(key);
    existing.unshift(entry);
    while (existing.length > this.capPerJobAiId) {
      existing.pop();
    }
    try {
      await this.redis.set(key, JSON.stringify(existing));
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, jobAiId: entry.jobAiId },
        "join token audit persist failed"
      );
    }
  }

  async revoke(jobAiId: number, jti: string, exp: number): Promise<void> {
    const ttlMs = Math.max(1000, exp - Date.now());
    try {
      await this.redis.set(this.revokedKey(jti), "1", ttlMs);
    } catch (err) {
      logger.warn({ err: (err as Error).message, jti }, "join token revoke failed");
    }
    const key = this.auditKey(jobAiId);
    const existing = await this.readAuditList(key);
    const now = Date.now();
    let mutated = false;
    for (const entry of existing) {
      if (entry.jti === jti && !entry.revokedAt) {
        entry.revokedAt = now;
        mutated = true;
      }
    }
    if (mutated) {
      try {
        await this.redis.set(key, JSON.stringify(existing));
      } catch {
        // best-effort
      }
    }
  }

  async isRevoked(jti: string): Promise<boolean> {
    try {
      const raw = await this.redis.get(this.revokedKey(jti));
      return raw !== null;
    } catch (err) {
      // If Redis is unreachable, fail-open on revocation check would be unsafe.
      // We choose to fail-closed (treat as revoked) so a downed Redis blocks new joins
      // rather than silently letting revoked tokens through.
      logger.error({ err: (err as Error).message, jti }, "join token revoke check failed");
      return true;
    }
  }

  async listAudit(jobAiId: number, limit: number = DEFAULT_LIMIT): Promise<JoinTokenAuditEntry[]> {
    const list = await this.readAuditList(this.auditKey(jobAiId));
    return list.slice(0, Math.max(0, limit));
  }

  private auditKey(jobAiId: number): string {
    return `${this.prefix}:join_token:audit:${jobAiId}`;
  }

  private revokedKey(jti: string): string {
    return `${this.prefix}:join_token:revoked:${jti}`;
  }

  private async readAuditList(key: string): Promise<JoinTokenAuditEntry[]> {
    try {
      const raw = await this.redis.get(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is JoinTokenAuditEntry => {
        return (
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as JoinTokenAuditEntry).jti === "string" &&
          typeof (entry as JoinTokenAuditEntry).jobAiId === "number"
        );
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, key }, "join token audit read failed");
      return [];
    }
  }
}
