import { HttpError } from "../middleware/errorHandler";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import { InMemoryInterviewStore, splitRuFullName } from "./interviewStore";
import { JobAiClient } from "./jobaiClient";
import { allowedJobAiTransitions, type InviteTokenRole, type JobAiInterview, type JobAiInterviewStatus, type StoredInterview } from "../types/interview";

const KNOWN_STATUSES = new Set<string>(Object.keys(allowedJobAiTransitions));
const TERMINAL_LOCK_STATUSES = new Set<JobAiInterviewStatus>(["canceled", "completed"]);

type ListOptions = {
  skip?: number;
  take?: number;
  sync?: boolean;
};

export class InterviewSyncService {
  constructor(
    private readonly jobAiClient: JobAiClient,
    private readonly store: InMemoryInterviewStore
  ) {}

  async ingestWebhook(payload: unknown): Promise<StoredInterview> {
    const interview = this.unwrapInterview(payload);
    const existing = this.store.getByJobAiId(interview.id);

    if (
      existing &&
      TERMINAL_LOCK_STATUSES.has(existing.rawPayload.status) &&
      existing.rawPayload.status !== interview.status
    ) {
      logger.warn(
        {
          jobAiId: interview.id,
          lockedStatus: existing.rawPayload.status,
          incomingStatus: interview.status
        },
        "webhook ingest: ignored status downgrade after terminal lock"
      );
      return existing;
    }

    const stored = this.store.upsert(interview);

    // Partner requirement: once canceled webhook is received, do NOT perform
    // any outbound status mutations from our side.
    if (stored.rawPayload.status === "canceled") {
      return stored;
    }

    // Partner request: once webhook is received, mark pending interviews as received.
    // Do it as best-effort so webhook ingest never fails because of downstream status API issues.
    if (stored.rawPayload.status === "pending" && this.jobAiClient.isConfigured()) {
      try {
        const received = await this.jobAiClient.updateInterviewStatus(stored.jobAiId, "received");
        return this.store.upsert(received);
      } catch (error) {
        logger.warn(
          {
            jobAiId: stored.jobAiId,
            fromStatus: stored.rawPayload.status,
            toStatus: "received",
            error: error instanceof Error ? error.message : String(error)
          },
          "webhook ingest: failed to auto-transition interview to received"
        );
      }
    }

    return stored;
  }

  async synchronize(skip = 0, take = 20): Promise<{ synced: number; total: number }> {
    if (!this.jobAiClient.isConfigured()) {
      throw new HttpError(503, "JobAI API is not configured");
    }

    try {
      const list = await this.jobAiClient.getInterviews(skip, take);
      for (const candidate of list.interviews) {
        const full = await this.jobAiClient.getInterviewById(candidate.id);
        this.store.upsert(full);
      }
      this.store.setSyncState({ status: "success" });
      return {
        synced: list.interviews.length,
        total: list.count
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to sync interviews";
      this.store.setSyncState({ status: "error", error: message });
      throw error;
    }
  }

  async listInterviews(options: ListOptions): Promise<{ interviews: StoredInterview[]; count: number }> {
    if (options.sync) {
      await this.synchronize(options.skip ?? 0, options.take ?? 20);
    }
    return this.store.list(options.skip ?? 0, options.take ?? 20);
  }

  async getInterview(jobAiId: number, forceSync = false): Promise<StoredInterview> {
    if (forceSync && this.jobAiClient.isConfigured()) {
      const full = await this.jobAiClient.getInterviewById(jobAiId);
      this.store.upsert(full);
    }
    const interview = this.store.getByJobAiId(jobAiId);
    if (!interview) {
      throw new HttpError(404, "Interview not found");
    }
    return interview;
  }

  getInterviewByInviteToken(inviteToken: string): { interview: StoredInterview; role: InviteTokenRole } | undefined {
    return this.store.getByInviteToken(inviteToken);
  }

  async transitionStatus(jobAiId: number, status: JobAiInterviewStatus): Promise<StoredInterview> {
    const current = await this.getInterview(jobAiId, !this.store.getByJobAiId(jobAiId));
    const fromStatus = current.rawPayload.status;
    const allowedTargets = (allowedJobAiTransitions[fromStatus] ?? []) as readonly JobAiInterviewStatus[];
    if (!allowedTargets.includes(status)) {
      throw new HttpError(400, "interviews.status_change_not_allowed", {
        fromStatus,
        toStatus: status
      });
    }

    if (!this.jobAiClient.isConfigured()) {
      throw new HttpError(503, "JobAI API is not configured");
    }

    const isTerminal = status === "completed" || status === "stopped_during_meeting";
    const projection = current.projection;
    const stream_call_id =
      (typeof projection.recording?.callId === "string" ? projection.recording.callId : undefined) ??
      (typeof projection.nullxesMeetingId === "string" ? projection.nullxesMeetingId : undefined);
    const stream_call_type =
      (typeof projection.recording?.callType === "string" ? projection.recording.callType : undefined) ??
      env.STREAM_CALL_TYPE;
    if (isTerminal && !stream_call_id) {
      logger.warn(
        { jobAiId, status, nullxesMeetingId: projection.nullxesMeetingId },
        "jobai status transition: stream_call_id is missing; sending status update without call binding"
      );
    }
    const updated = await this.jobAiClient.updateInterviewStatus(jobAiId, status, { stream_call_id, stream_call_type });
    return this.store.upsert(updated);
  }

  async cancelInterview(jobAiId: number): Promise<StoredInterview> {
    return this.transitionStatus(jobAiId, "canceled");
  }

  attachSession(
    jobAiId: number,
    params: { meetingId: string; sessionId?: string; nullxesStatus?: "idle" | "in_meeting" | "completed" | "stopped_during_meeting" | "failed" }
  ): StoredInterview {
    return this.store.setRuntimeSession(jobAiId, params);
  }

  attachRecording(
    jobAiId: number,
    recording: {
      state: "idle" | "starting" | "recording" | "stopping" | "stopped" | "ready" | "failed";
      callType?: string;
      callId?: string;
      activeRecordingId?: string;
      latestDownloadUrl?: string;
      latestFilename?: string;
      codec?: string;
      container?: string;
    }
  ): StoredInterview {
    return this.store.setRecordingProjection(jobAiId, {
      ...recording,
      updatedAt: new Date().toISOString()
    });
  }

  /**
   * Прототип: сохранить ФИО кандидата в проекции gateway (raw JobAI не меняем).
   * Разбор «Фамилия Имя Отчество»: первая лексема → candidateLastName, остальное → candidateFirstName.
   */
  setPrototypeCandidateFio(jobAiId: number, fullName: string): StoredInterview {
    const existing = this.store.getByJobAiId(jobAiId);
    if (!existing) {
      throw new HttpError(404, "Interview not found");
    }
    const trimmed = fullName.trim();
    if (!trimmed) {
      return this.store.clearPrototypeIdentity(jobAiId);
    }
    const { candidateFirstName, candidateLastName } = splitRuFullName(trimmed);
    return this.store.setPrototypeIdentity(jobAiId, {
      candidateFirstName,
      candidateLastName,
      sourceFullName: trimmed,
      updatedAt: new Date().toISOString()
    });
  }

  getEntryPaths(jobAiId: number): { candidateEntryPath: string; spectatorEntryPath: string } {
    const stored = this.store.getByJobAiId(jobAiId);
    if (!stored) {
      throw new HttpError(404, "Interview not found");
    }
    return {
      candidateEntryPath: stored.projection.candidateEntryPath,
      spectatorEntryPath: stored.projection.spectatorEntryPath
    };
  }

  getIntegrationStatus(): {
    endpoints: Array<{ endpoint: string; status: "active" | "queued" | "disabled" }>;
    sync: ReturnType<InMemoryInterviewStore["getSyncState"]>;
  } {
    return {
      endpoints: [
        { endpoint: "GET /ai-api/interviews/{id}", status: this.jobAiClient.isConfigured() ? "active" : "disabled" },
        { endpoint: "GET /ai-api/interviews", status: this.jobAiClient.isConfigured() ? "active" : "disabled" },
        { endpoint: "POST /ai-api/interviews/{id}/status", status: this.jobAiClient.isConfigured() ? "queued" : "disabled" }
      ],
      sync: this.store.getSyncState()
    };
  }

  private unwrapInterview(payload: unknown): JobAiInterview {
    if (!payload || typeof payload !== "object") {
      throw new HttpError(400, "Invalid webhook payload");
    }

    const asRecord = payload as Record<string, unknown>;
    const candidate = (asRecord.interview ?? asRecord) as unknown;
    if (!candidate || typeof candidate !== "object") {
      throw new HttpError(400, "Invalid webhook payload");
    }
    const interview = candidate as Record<string, unknown>;
    // New preferred key from partner webhook: interviewId.
    // Keep legacy id for backward compatibility during migration.
    const rawInterviewId = typeof interview.interviewId === "number"
      ? interview.interviewId
      : typeof interview.id === "number"
        ? interview.id
        : undefined;
    if (typeof rawInterviewId !== "number" || typeof interview.status !== "string") {
      throw new HttpError(400, "Invalid interview object");
    }
    if (!KNOWN_STATUSES.has(interview.status)) {
      throw new HttpError(400, "Invalid interview status");
    }
    return {
      ...interview,
      id: rawInterviewId
    } as unknown as JobAiInterview;
  }
}
