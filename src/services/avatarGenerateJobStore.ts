import type { MinimalRedisClient } from "./redisClient";

export type AvatarGenerateJobState =
  | "queued"
  | "processing"
  | "hydrating"
  | "completed"
  | "failed";

export type AvatarGenerateJobRecord = {
  id: string;
  state: AvatarGenerateJobState;
  createdAtMs: number;
  updatedAtMs: number;
  /** ISO 8601 — session start (enqueue). */
  startedAt?: string;
  /** ISO 8601 — first transition to `processing`. */
  processingStartedAt?: string;
  /** ISO 8601 — terminal success. */
  completedAt?: string;
  /** ISO 8601 — terminal failure. */
  failedAt?: string;
  /** Number of failed RunPod attempts before success or final failure (0 = first attempt only). */
  retryCount: number;
  prompt: string;
  errorMessage?: string;
  /** Absolute public URL to the generated video (orchestrator-built from RUNPOD_RUNTIME_URL + result[0]). */
  videoUrl?: string;
  /** @deprecated Prefer `videoUrl`; kept for older clients. */
  resultVideoUrl?: string;
  /** Raw JSON from GPU when useful for debugging. */
  resultPayload?: unknown;
};

type MemoryEntry = { job: AvatarGenerateJobRecord; expiresAtMs: number };

function migrateJob(raw: AvatarGenerateJobRecord): AvatarGenerateJobRecord {
  const nowIso = new Date(raw.createdAtMs).toISOString();
  const retryCount = typeof raw.retryCount === "number" && Number.isFinite(raw.retryCount) ? raw.retryCount : 0;
  return {
    ...raw,
    retryCount,
    startedAt: raw.startedAt ?? nowIso,
    processingStartedAt: raw.processingStartedAt,
    completedAt: raw.completedAt,
    failedAt: raw.failedAt
  };
}

export class AvatarGenerateJobStore {
  private readonly memory = new Map<string, MemoryEntry>();

  constructor(
    private readonly options: {
      redis?: MinimalRedisClient;
      prefix: string;
      ttlMs: number;
    }
  ) {}

  private redisKey(jobId: string): string {
    return `${this.options.prefix}:avatar-gen-job:${jobId}`;
  }

  private matchPattern(): string {
    return `${this.options.prefix}:avatar-gen-job:*`;
  }

  async get(jobId: string): Promise<AvatarGenerateJobRecord | null> {
    const redis = this.options.redis;
    if (redis) {
      const raw = await redis.get(this.redisKey(jobId)).catch(() => null);
      if (!raw || typeof raw !== "string") return null;
      try {
        return migrateJob(JSON.parse(raw) as AvatarGenerateJobRecord);
      } catch {
        return null;
      }
    }
    const entry = this.memory.get(jobId);
    if (!entry || Date.now() > entry.expiresAtMs) {
      this.memory.delete(jobId);
      return null;
    }
    return migrateJob(entry.job);
  }

  async save(job: AvatarGenerateJobRecord): Promise<void> {
    const normalized: AvatarGenerateJobRecord = {
      ...job,
      retryCount: typeof job.retryCount === "number" ? job.retryCount : 0,
      updatedAtMs: Date.now()
    };
    const redis = this.options.redis;
    if (redis) {
      await redis
        .set(this.redisKey(normalized.id), JSON.stringify(normalized), this.options.ttlMs)
        .catch(() => undefined);
      return;
    }
    this.memory.set(normalized.id, {
      job: normalized,
      expiresAtMs: Date.now() + this.options.ttlMs
    });
    this.pruneMemory();
  }

  /** All persisted avatar-gen jobs (Redis SCAN or in-memory). For stale recovery / ops. */
  async listJobs(): Promise<AvatarGenerateJobRecord[]> {
    const redis = this.options.redis;
    if (redis) {
      const keys = await redis.scanAll(this.matchPattern()).catch(() => [] as string[]);
      const out: AvatarGenerateJobRecord[] = [];
      for (const key of keys) {
        const raw = await redis.get(key).catch(() => null);
        if (!raw || typeof raw !== "string") continue;
        try {
          out.push(migrateJob(JSON.parse(raw) as AvatarGenerateJobRecord));
        } catch {
          continue;
        }
      }
      return out;
    }
    return Array.from(this.memory.values()).map((e) => migrateJob(e.job));
  }

  private pruneMemory(): void {
    const now = Date.now();
    for (const [id, entry] of this.memory) {
      if (now > entry.expiresAtMs) this.memory.delete(id);
    }
  }
}
