import { randomInt } from "node:crypto";
import type {
  InterviewInviteTokens,
  InterviewProjection,
  InviteTokenRole,
  JobAiInterview,
  JobAiInterviewStatus,
  PrototypeCandidateIdentity,
  StoredInterview
} from "../types/interview";
import { resolveNullxesBusiness } from "./nullxesBusinessStatus";

const INVITE_TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const INVITE_TOKEN_LENGTH = 10;
const MEETING_CONTROL_KEY_LENGTH = 16;

type InviteTokenLookup = {
  interview: StoredInterview;
  role: InviteTokenRole;
};

export function splitRuFullName(fullName: string): { candidateLastName: string; candidateFirstName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { candidateLastName: "", candidateFirstName: "" };
  }
  if (parts.length === 1) {
    return { candidateLastName: parts[0], candidateFirstName: "" };
  }
  return { candidateLastName: parts[0], candidateFirstName: parts.slice(1).join(" ") };
}

export class InMemoryInterviewStore {
  protected readonly byJobAiId = new Map<number, StoredInterview>();
  protected readonly byInviteToken = new Map<string, { jobAiId: number; role: InviteTokenRole }>();
  protected readonly byNumericMeetingId = new Map<number, number>();
  protected readonly meetingIds = new Set<number>();
  protected lastSyncAt: string | null = null;
  protected lastSyncResult: "idle" | "success" | "error" = "idle";
  protected lastSyncError: string | null = null;

  /** Гидратирует одну запись из persistent storage. */
  hydrate(record: StoredInterview): boolean {
    const previous = this.byJobAiId.get(record.jobAiId);
    if (previous) {
      this.unindexInviteProjection(previous);
    }
    const changed = this.ensureInviteProjection(record);
    this.byJobAiId.set(record.jobAiId, record);
    this.indexInviteProjection(record);
    return changed;
  }

  /** Гидратирует sync-метаданные из persistent storage. */
  hydrateSyncState(state: { lastSyncAt: string | null; lastSyncResult: "idle" | "success" | "error"; lastSyncError: string | null }): void {
    this.lastSyncAt = state.lastSyncAt;
    this.lastSyncResult = state.lastSyncResult;
    this.lastSyncError = state.lastSyncError;
  }

  upsert(rawPayload: JobAiInterview): StoredInterview {
    const existing = this.byJobAiId.get(rawPayload.id);
    const nullxesStatus = this.resolveNullxesStatus(rawPayload.status, existing?.projection.nullxesStatus);
    const business = resolveNullxesBusiness(rawPayload.status, nullxesStatus);
    const inviteProjection = this.getOrCreateInviteProjection(existing);
    const projection: InterviewProjection = {
      jobAiId: rawPayload.id,
      meetingId: inviteProjection.meetingId,
      meetingControlKey: inviteProjection.meetingControlKey,
      inviteTokens: inviteProjection.inviteTokens,
      nullxesMeetingId: existing?.projection.nullxesMeetingId,
      sessionId: existing?.projection.sessionId,
      candidateFirstName: rawPayload.candidateFirstName ?? "",
      candidateLastName: rawPayload.candidateLastName ?? "",
      companyName: rawPayload.companyName,
      meetingAt: rawPayload.meetingAt,
      jobAiStatus: rawPayload.status,
      nullxesStatus,
      candidateEntryPath: `/?jobAiId=${rawPayload.id}`,
      spectatorEntryPath: `/spectator?jobAiId=${rawPayload.id}`,
      nullxesBusinessKey: business.key,
      nullxesBusinessLabel: business.label,
      updatedAt: new Date().toISOString()
    };

    const prototypeIdentity = existing?.prototypeIdentity;
    if (prototypeIdentity) {
      projection.candidateFirstName = prototypeIdentity.candidateFirstName;
      projection.candidateLastName = prototypeIdentity.candidateLastName;
    }

    const stored: StoredInterview = {
      jobAiId: rawPayload.id,
      rawPayload,
      projection,
      prototypeIdentity
    };
    if (existing) {
      this.unindexInviteProjection(existing);
    }
    this.byJobAiId.set(rawPayload.id, stored);
    this.indexInviteProjection(stored);
    return stored;
  }

  getByJobAiId(jobAiId: number): StoredInterview | undefined {
    return this.byJobAiId.get(jobAiId);
  }

  getByInviteToken(inviteToken: string): InviteTokenLookup | undefined {
    const indexed = this.byInviteToken.get(inviteToken);
    if (!indexed) {
      return undefined;
    }
    const interview = this.byJobAiId.get(indexed.jobAiId);
    if (!interview) {
      this.byInviteToken.delete(inviteToken);
      return undefined;
    }
    return { interview, role: indexed.role };
  }

  getByNumericMeetingId(meetingId: number): StoredInterview | undefined {
    const jobAiId = this.byNumericMeetingId.get(meetingId);
    return typeof jobAiId === "number" ? this.byJobAiId.get(jobAiId) : undefined;
  }

  list(skip = 0, take = 20): { interviews: StoredInterview[]; count: number } {
    const ts = (raw: string | undefined): number => {
      if (!raw) return 0;
      const t = new Date(raw).getTime();
      return Number.isFinite(t) ? t : 0;
    };
    const all = Array.from(this.byJobAiId.values()).sort((a, b) => {
      const bc = ts(b.rawPayload.createdAt);
      const ac = ts(a.rawPayload.createdAt);
      if (bc !== ac) return bc - ac;
      const bm = ts(b.rawPayload.meetingAt);
      const am = ts(a.rawPayload.meetingAt);
      if (bm !== am) return bm - am;
      return b.rawPayload.id - a.rawPayload.id;
    });
    return {
      interviews: all.slice(skip, skip + take),
      count: all.length
    };
  }

  setPrototypeIdentity(jobAiId: number, identity: PrototypeCandidateIdentity): StoredInterview {
    const existing = this.byJobAiId.get(jobAiId);
    if (!existing) {
      throw new Error(`Interview not found: ${jobAiId}`);
    }
    existing.prototypeIdentity = identity;
    existing.projection.candidateFirstName = identity.candidateFirstName;
    existing.projection.candidateLastName = identity.candidateLastName;
    existing.projection.updatedAt = new Date().toISOString();
    return existing;
  }

  clearPrototypeIdentity(jobAiId: number): StoredInterview {
    const existing = this.byJobAiId.get(jobAiId);
    if (!existing) {
      throw new Error(`Interview not found: ${jobAiId}`);
    }
    delete existing.prototypeIdentity;
    existing.projection.candidateFirstName = existing.rawPayload.candidateFirstName ?? "";
    existing.projection.candidateLastName = existing.rawPayload.candidateLastName ?? "";
    existing.projection.updatedAt = new Date().toISOString();
    return existing;
  }

  setRuntimeSession(
    jobAiId: number,
    params: { meetingId: string; sessionId?: string; nullxesStatus?: InterviewProjection["nullxesStatus"] }
  ): StoredInterview {
    const existing = this.byJobAiId.get(jobAiId);
    if (!existing) {
      throw new Error(`Interview not found: ${jobAiId}`);
    }

    existing.projection.nullxesMeetingId = params.meetingId;
    existing.projection.sessionId = params.sessionId ?? existing.projection.sessionId;
    if (params.nullxesStatus) {
      existing.projection.nullxesStatus = params.nullxesStatus;
    }
    const business = resolveNullxesBusiness(existing.rawPayload.status, existing.projection.nullxesStatus);
    existing.projection.nullxesBusinessKey = business.key;
    existing.projection.nullxesBusinessLabel = business.label;
    existing.projection.updatedAt = new Date().toISOString();
    return existing;
  }

  setRecordingProjection(
    jobAiId: number,
    recording: NonNullable<InterviewProjection["recording"]>
  ): StoredInterview {
    const existing = this.byJobAiId.get(jobAiId);
    if (!existing) {
      throw new Error(`Interview not found: ${jobAiId}`);
    }
    existing.projection.recording = recording;
    existing.projection.updatedAt = new Date().toISOString();
    return existing;
  }

  setSyncState(result: { status: "success" | "error"; error?: string }): void {
    this.lastSyncAt = new Date().toISOString();
    this.lastSyncResult = result.status;
    this.lastSyncError = result.error ?? null;
  }

  getSyncState(): { lastSyncAt: string | null; lastSyncResult: "idle" | "success" | "error"; lastSyncError: string | null; storedCount: number } {
    return {
      lastSyncAt: this.lastSyncAt,
      lastSyncResult: this.lastSyncResult,
      lastSyncError: this.lastSyncError,
      storedCount: this.byJobAiId.size
    };
  }

  private resolveNullxesStatus(
    jobAiStatus: JobAiInterviewStatus,
    current: InterviewProjection["nullxesStatus"] | undefined
  ): InterviewProjection["nullxesStatus"] {
    if (current === "in_meeting" && jobAiStatus === "in_meeting") {
      return "in_meeting";
    }

    if (jobAiStatus === "completed") {
      return "completed";
    }

    if (jobAiStatus === "stopped_during_meeting" || jobAiStatus === "canceled" || jobAiStatus === "meeting_not_started") {
      return "stopped_during_meeting";
    }

    return current ?? "idle";
  }

  private getOrCreateInviteProjection(existing: StoredInterview | undefined): {
    meetingId: number;
    meetingControlKey: string;
    inviteTokens: InterviewInviteTokens;
  } {
    if (existing) {
      this.ensureInviteProjection(existing);
      return {
        meetingId: existing.projection.meetingId,
        meetingControlKey: existing.projection.meetingControlKey,
        inviteTokens: existing.projection.inviteTokens
      };
    }

    return {
      meetingId: this.generateUniqueMeetingId(),
      meetingControlKey: this.generateUniqueToken(MEETING_CONTROL_KEY_LENGTH),
      inviteTokens: this.generateInviteTokenSet()
    };
  }

  protected ensureInviteProjection(record: StoredInterview): boolean {
    let changed = false;
    const projection = record.projection as InterviewProjection & {
      meetingId?: unknown;
      meetingControlKey?: unknown;
      inviteTokens?: Partial<Record<InviteTokenRole, unknown>>;
    };

    if (typeof projection.meetingId !== "number" || !Number.isSafeInteger(projection.meetingId) || projection.meetingId <= 0) {
      projection.meetingId = this.generateUniqueMeetingId();
      changed = true;
    } else if (this.meetingIds.has(projection.meetingId)) {
      const existing = this.byJobAiId.get(record.jobAiId);
      if (!existing || existing.projection.meetingId !== projection.meetingId) {
        projection.meetingId = this.generateUniqueMeetingId();
        changed = true;
      }
    }

    if (typeof projection.meetingControlKey !== "string" || !isAlphaNumericLength(projection.meetingControlKey, MEETING_CONTROL_KEY_LENGTH)) {
      projection.meetingControlKey = this.generateUniqueToken(MEETING_CONTROL_KEY_LENGTH);
      changed = true;
    }

    const currentTokens: Partial<Record<InviteTokenRole, unknown>> =
      projection.inviteTokens && typeof projection.inviteTokens === "object" ? projection.inviteTokens : {};
    const nextTokens = this.normalizeInviteTokenSet(currentTokens, record.jobAiId);
    if (
      currentTokens.candidate !== nextTokens.candidate ||
      currentTokens.observer !== nextTokens.observer ||
      currentTokens.admin !== nextTokens.admin
    ) {
      projection.inviteTokens = nextTokens;
      changed = true;
    }

    return changed;
  }

  private indexInviteProjection(record: StoredInterview): void {
    this.meetingIds.add(record.projection.meetingId);
    this.byNumericMeetingId.set(record.projection.meetingId, record.jobAiId);
    this.byInviteToken.set(record.projection.inviteTokens.candidate, { jobAiId: record.jobAiId, role: "candidate" });
    this.byInviteToken.set(record.projection.inviteTokens.observer, { jobAiId: record.jobAiId, role: "observer" });
    this.byInviteToken.set(record.projection.inviteTokens.admin, { jobAiId: record.jobAiId, role: "admin" });
  }

  private unindexInviteProjection(record: StoredInterview): void {
    this.byNumericMeetingId.delete(record.projection.meetingId);
    for (const [token, indexed] of this.byInviteToken.entries()) {
      if (indexed.jobAiId === record.jobAiId) {
        this.byInviteToken.delete(token);
      }
    }
  }

  private normalizeInviteTokenSet(
    currentTokens: Partial<Record<InviteTokenRole, unknown>>,
    jobAiId: number
  ): InterviewInviteTokens {
    const used = new Set<string>();
    const next = {} as InterviewInviteTokens;
    for (const role of ["candidate", "observer", "admin"] as const) {
      const current = currentTokens[role];
      if (
        typeof current === "string" &&
        isAlphaNumericLength(current, INVITE_TOKEN_LENGTH) &&
        !used.has(current)
      ) {
        const indexed = this.byInviteToken.get(current);
        if (!indexed || indexed.jobAiId === jobAiId) {
          next[role] = current;
          used.add(current);
          continue;
        }
      }
      next[role] = this.generateUniqueInviteToken(used);
      used.add(next[role]);
    }
    return next;
  }

  private generateInviteTokenSet(): InterviewInviteTokens {
    const used = new Set<string>();
    const candidate = this.generateUniqueInviteToken(used);
    used.add(candidate);
    const observer = this.generateUniqueInviteToken(used);
    used.add(observer);
    const admin = this.generateUniqueInviteToken(used);
    return { candidate, observer, admin };
  }

  private generateUniqueInviteToken(disallow: ReadonlySet<string> = new Set()): string {
    return this.generateUniqueToken(INVITE_TOKEN_LENGTH, (token) => !this.byInviteToken.has(token) && !disallow.has(token));
  }

  private generateUniqueMeetingId(): number {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const meetingId = randomInt(100_000_000, 1_000_000_000);
      if (!this.meetingIds.has(meetingId)) {
        return meetingId;
      }
    }
    throw new Error("Unable to generate unique meetingId");
  }

  private generateUniqueToken(length: number, isAvailable: (token: string) => boolean = () => true): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let token = "";
      for (let i = 0; i < length; i += 1) {
        token += INVITE_TOKEN_ALPHABET[randomInt(0, INVITE_TOKEN_ALPHABET.length)];
      }
      if (isAvailable(token)) {
        return token;
      }
    }
    throw new Error(`Unable to generate unique token length=${length}`);
  }
}

function isAlphaNumericLength(value: string, length: number): boolean {
  return value.length === length && /^[A-Za-z0-9]+$/.test(value);
}
