import type {
  InterviewProjection,
  JobAiInterview,
  JobAiInterviewStatus,
  PrototypeCandidateIdentity,
  StoredInterview
} from "../types/interview";
import { resolveNullxesBusiness } from "./nullxesBusinessStatus";

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
  protected lastSyncAt: string | null = null;
  protected lastSyncResult: "idle" | "success" | "error" = "idle";
  protected lastSyncError: string | null = null;

  /** Гидратирует одну запись из persistent storage. */
  hydrate(record: StoredInterview): void {
    this.byJobAiId.set(record.jobAiId, record);
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
    const projection: InterviewProjection = {
      jobAiId: rawPayload.id,
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
    this.byJobAiId.set(rawPayload.id, stored);
    return stored;
  }

  getByJobAiId(jobAiId: number): StoredInterview | undefined {
    return this.byJobAiId.get(jobAiId);
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
}
