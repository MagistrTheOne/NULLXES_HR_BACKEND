import type { MinimalRedisClient } from "./redisClient";

export type CanonicalRuntimePhase =
  | "starting"
  | "in_meeting"
  | "paused"
  | "stopped"
  | "failed"
  | "degraded";

export type CanonicalEngine = "echomimic" | "echomimic_realtime" | "arachne" | "behavior_static" | "none";

export interface RuntimeSessionState {
  schemaVersion: "1.0";
  meetingId: string;
  activeSpeaker: "candidate" | "assistant";
  phase: CanonicalRuntimePhase;
  engine: CanonicalEngine;
  degradationLevel: 0 | 1 | 2 | 3 | 4;
  avatarReady: boolean;
  revision: number;
  updatedAtMs: number;
  ownership: {
    gatewayUpdatedAtMs: number;
    podUpdatedAtMs?: number;
  };
}

export class RuntimeSessionStateStore {
  private readonly memory = new Map<string, RuntimeSessionState>();

  constructor(
    private readonly options?: {
      redis?: MinimalRedisClient;
      prefix?: string;
      ttlMs?: number;
    }
  ) {}

  async get(meetingId: string): Promise<RuntimeSessionState | null> {
    const local = this.memory.get(meetingId);
    if (local) return local;
    const redis = this.options?.redis;
    if (!redis) return null;
    const raw = await redis.get(this.redisKey(meetingId)).catch(() => null);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RuntimeSessionState;
    this.memory.set(meetingId, parsed);
    return parsed;
  }

  async upsert(
    meetingId: string,
    patch: Partial<Omit<RuntimeSessionState, "schemaVersion" | "meetingId" | "revision" | "updatedAtMs">>
  ): Promise<RuntimeSessionState> {
    const now = Date.now();
    const current = (await this.get(meetingId)) ?? {
      schemaVersion: "1.0" as const,
      meetingId,
      activeSpeaker: "assistant" as const,
      phase: "starting" as const,
      engine: "none" as const,
      degradationLevel: 0 as const,
      avatarReady: false,
      revision: 0,
      updatedAtMs: now,
      ownership: {
        gatewayUpdatedAtMs: now
      }
    };
    const next: RuntimeSessionState = {
      ...current,
      ...patch,
      ownership: {
        ...current.ownership,
        ...(patch.ownership ?? {}),
        gatewayUpdatedAtMs: now
      },
      revision: current.revision + 1,
      updatedAtMs: now
    };
    this.memory.set(meetingId, next);
    await this.persist(meetingId, next);
    return next;
  }

  async delete(meetingId: string): Promise<void> {
    this.memory.delete(meetingId);
    const redis = this.options?.redis;
    if (!redis) return;
    await redis.del(this.redisKey(meetingId)).catch(() => undefined);
  }

  async markPodHeartbeat(meetingId: string, atMs = Date.now()): Promise<RuntimeSessionState | null> {
    const current = await this.get(meetingId);
    if (!current) return null;
    const next: RuntimeSessionState = {
      ...current,
      ownership: { ...current.ownership, podUpdatedAtMs: atMs },
      revision: current.revision + 1,
      updatedAtMs: atMs
    };
    this.memory.set(meetingId, next);
    await this.persist(meetingId, next);
    return next;
  }

  private async persist(meetingId: string, value: RuntimeSessionState): Promise<void> {
    const redis = this.options?.redis;
    if (!redis) return;
    await redis
      .set(this.redisKey(meetingId), JSON.stringify(value), this.options?.ttlMs)
      .catch(() => undefined);
  }

  private redisKey(meetingId: string): string {
    return `${this.options?.prefix ?? "nullxes:hr-ai"}:session:${meetingId}`;
  }
}

