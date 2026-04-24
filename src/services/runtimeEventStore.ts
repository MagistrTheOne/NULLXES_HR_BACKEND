import { randomUUID } from "node:crypto";
import type { RuntimeCommandRecord, RuntimeEvent, RuntimeEventType } from "../types/runtime";
import type { MinimalRedisClient } from "./redisClient";

export interface RuntimeEventAppendInput {
  type: RuntimeEventType;
  meetingId?: string;
  sessionId?: string;
  jobAiId?: number;
  actor?: string;
  payload?: Record<string, unknown>;
}

type RuntimeState = {
  revision: number;
  events: RuntimeEvent[];
  lastCommand?: RuntimeCommandRecord;
};

export class RuntimeEventStore {
  private readonly states = new Map<string, RuntimeState>();

  constructor(
    private readonly options?: {
      redis?: MinimalRedisClient;
      prefix?: string;
      maxEventsPerRuntime?: number;
    }
  ) {}

  async append(input: RuntimeEventAppendInput): Promise<RuntimeEvent> {
    const key = this.resolveRuntimeKey(input);
    const state = await this.loadState(key);
    const event: RuntimeEvent = {
      id: randomUUID(),
      type: input.type,
      meetingId: input.meetingId,
      sessionId: input.sessionId,
      jobAiId: input.jobAiId,
      actor: input.actor,
      timestampMs: Date.now(),
      revision: state.revision + 1,
      payload: input.payload ?? {}
    };
    state.revision = event.revision;
    state.events.push(event);
    const max = this.options?.maxEventsPerRuntime ?? 500;
    if (state.events.length > max) {
      state.events.splice(0, state.events.length - max);
    }
    await this.saveState(key, state);
    return event;
  }

  async recordCommand(command: RuntimeCommandRecord): Promise<void> {
    const state = await this.loadState(command.meetingId);
    state.lastCommand = command;
    state.revision = Math.max(state.revision, command.revision);
    await this.saveState(command.meetingId, state);
  }

  async getEvents(meetingId: string, afterRevision = 0): Promise<RuntimeEvent[]> {
    const state = await this.loadState(meetingId);
    return state.events.filter((event) => event.revision > afterRevision);
  }

  async getRevision(meetingId: string): Promise<number> {
    const state = await this.loadState(meetingId);
    return state.revision;
  }

  async getLastCommand(meetingId: string): Promise<RuntimeCommandRecord | undefined> {
    const state = await this.loadState(meetingId);
    return state.lastCommand;
  }

  private resolveRuntimeKey(input: RuntimeEventAppendInput): string {
    if (input.meetingId) {
      return input.meetingId;
    }
    if (input.sessionId) {
      return `session:${input.sessionId}`;
    }
    if (typeof input.jobAiId === "number") {
      return `interview:${input.jobAiId}`;
    }
    return "global";
  }

  private async loadState(key: string): Promise<RuntimeState> {
    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }
    const redis = this.options?.redis;
    if (redis) {
      const raw = await redis.get(this.redisKey(key)).catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw) as RuntimeState;
        this.states.set(key, parsed);
        return parsed;
      }
    }
    const created: RuntimeState = { revision: 0, events: [] };
    this.states.set(key, created);
    return created;
  }

  private async saveState(key: string, state: RuntimeState): Promise<void> {
    this.states.set(key, state);
    const redis = this.options?.redis;
    if (redis) {
      await redis.set(this.redisKey(key), JSON.stringify(state)).catch(() => undefined);
    }
  }

  private redisKey(key: string): string {
    return `${this.options?.prefix ?? "nullxes:hr-ai"}:runtime:${key}`;
  }
}
