import { logger } from "../logging/logger";
import type {
  CandidateAdmissionDecision,
  CandidateAdmissionDecisionResult,
  CandidateAdmissionRelease,
  CandidateAdmissionRequest,
  CandidateAdmissionResult,
  CandidateAdmissionStatusView,
  MeetingRecord,
  MeetingStatus,
  MeetingTransitionEvent,
  StartMeetingInput
} from "../types/meeting";
import { InMemoryMeetingStore } from "./meetingStore";
import type { MinimalRedisClient } from "./redisClient";

interface PersistedMeetingStoreOptions {
  redis: MinimalRedisClient;
  prefix: string;
}

interface PersistedMeetingPayload {
  record: MeetingRecord;
  history: MeetingTransitionEvent[];
}

export class PersistedMeetingStore extends InMemoryMeetingStore {
  private readonly redis: MinimalRedisClient;
  private readonly prefix: string;

  constructor(options: PersistedMeetingStoreOptions) {
    super();
    this.redis = options.redis;
    this.prefix = options.prefix;
  }

  async loadAll(): Promise<void> {
    const pattern = `${this.prefix}:meeting:*`;
    const keys = await this.redis.scanAll(pattern, 200);
    let restored = 0;
    for (const key of keys) {
      try {
        const payload = await this.redis.get(key);
        if (!payload) continue;
        const parsed = JSON.parse(payload) as PersistedMeetingPayload;
        if (parsed?.record?.meetingId) {
          this.hydrate(parsed.record, Array.isArray(parsed.history) ? parsed.history : []);
          restored += 1;
        }
      } catch (error) {
        logger.warn({ key, err: error }, "failed to hydrate meeting record from redis");
      }
    }
    if (restored > 0) {
      logger.info({ restored }, "hydrated meetings from redis");
    }

    const legacyKey = `${this.prefix}:meetings`;
    try {
      const legacy = await this.redis.get(legacyKey);
      if (legacy) {
        const arr = JSON.parse(legacy) as PersistedMeetingPayload[];
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (item?.record?.meetingId) {
              this.hydrate(item.record, Array.isArray(item.history) ? item.history : []);
              await this.persist(item.record.meetingId);
            }
          }
        }
        await this.redis.del(legacyKey);
        logger.info({ migrated: arr.length }, "migrated legacy meeting blob to per-key keys");
      }
    } catch (error) {
      logger.warn({ err: error }, "legacy meeting blob migration skipped");
    }
  }

  override createMeeting(input: StartMeetingInput): MeetingRecord {
    const record = super.createMeeting(input);
    void this.persist(record.meetingId);
    return record;
  }

  override updateMeetingStatus(params: {
    meetingId: string;
    toStatus: MeetingStatus;
    reason: string;
    metadata?: Record<string, unknown>;
    sessionId?: string;
  }): MeetingTransitionEvent {
    const transition = super.updateMeetingStatus(params);
    void this.persist(params.meetingId);
    return transition;
  }

  /** Сохранить произвольный мутированный meeting (используется admission). */
  async persistMeeting(meetingId: string): Promise<void> {
    return this.persist(meetingId);
  }

  override acquireCandidateAdmission(
    meetingId: string,
    request: CandidateAdmissionRequest,
    rejoinWindowMs: number
  ): CandidateAdmissionResult | undefined {
    const result = super.acquireCandidateAdmission(meetingId, request, rejoinWindowMs);
    if (result) void this.persist(meetingId);
    return result;
  }

  override releaseCandidateAdmission(
    meetingId: string,
    request: CandidateAdmissionRelease,
    rejoinWindowMs: number
  ): { released: boolean; status: CandidateAdmissionStatusView } | undefined {
    const result = super.releaseCandidateAdmission(meetingId, request, rejoinWindowMs);
    if (result) void this.persist(meetingId);
    return result;
  }

  override decideCandidateAdmission(
    meetingId: string,
    decision: CandidateAdmissionDecision,
    rejoinWindowMs: number
  ): CandidateAdmissionDecisionResult | undefined {
    const result = super.decideCandidateAdmission(meetingId, decision, rejoinWindowMs);
    if (result) void this.persist(meetingId);
    return result;
  }

  private async persist(meetingId: string): Promise<void> {
    const record = this.meetings.get(meetingId);
    if (!record) return;
    const history = this.history.get(meetingId) ?? [];
    const payload: PersistedMeetingPayload = { record, history };
    try {
      await this.redis.set(this.keyFor(meetingId), JSON.stringify(payload));
    } catch (error) {
      logger.warn({ err: error, meetingId }, "failed to persist meeting to redis");
    }
  }

  private keyFor(meetingId: string): string {
    return `${this.prefix}:meeting:${meetingId}`;
  }
}
