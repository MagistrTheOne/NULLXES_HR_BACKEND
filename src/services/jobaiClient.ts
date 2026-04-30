import { Buffer } from "node:buffer";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";
import type { InterviewsListResponse, JobAiInterview, JobAiInterviewStatus } from "../types/interview";

type JsonRecord = Record<string, unknown>;

function isObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

export class JobAiClient {
  isConfigured(): boolean {
    return Boolean(env.JOBAI_API_BASE_URL);
  }

  async createInterview(payload: Record<string, unknown>): Promise<JobAiInterview> {
    const response = await this.request<JsonRecord>("/ai-api/interviews", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    return this.extractInterview(response);
  }

  async getInterviews(skip = 0, take = 20): Promise<InterviewsListResponse> {
    const response = await this.request<JsonRecord>(`/ai-api/interviews?skip=${skip}&take=${take}`, {
      method: "GET"
    });
    const interviews = Array.isArray(response.interviews) ? (response.interviews as JobAiInterview[]) : [];
    return {
      interviews,
      count: typeof response.count === "number" ? response.count : interviews.length
    };
  }

  async getInterviewById(id: number): Promise<JobAiInterview> {
    const response = await this.request<JsonRecord>(`/ai-api/interviews/${id}`, {
      method: "GET"
    });
    return this.extractInterview(response);
  }

  async updateInterviewStatus(
    id: number,
    status: JobAiInterviewStatus,
    opts?: { stream_call_id?: string; stream_call_type?: string }
  ): Promise<JobAiInterview> {
    const stream_call_id = opts?.stream_call_id?.trim();
    const stream_call_type = opts?.stream_call_type?.trim();
    const response = await this.request<JsonRecord>(`/ai-api/interviews/${id}/status`, {
      method: "POST",
      body: JSON.stringify({
        status,
        ...(stream_call_id ? { stream_call_id } : {}),
        ...(stream_call_type ? { stream_call_type } : {})
      })
    });
    return this.extractInterview(response);
  }

  async getSpecialty(id: number): Promise<unknown> {
    return this.request<unknown>(`/ai-api/specialties/${id}`, {
      method: "GET"
    });
  }

  async getSettings(): Promise<unknown> {
    return this.request<unknown>("/ai-api/settings", {
      method: "GET"
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    if (!env.JOBAI_API_BASE_URL) {
      throw new HttpError(503, "JobAI API is not configured");
    }

    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const target = new URL(normalizedPath, env.JOBAI_API_BASE_URL);
    const headers = this.buildHeaders(init.headers);
    const response = await fetch(target, {
      ...init,
      headers
    });

    const rawBody = await response.text();
    let payload: unknown;
    if (rawBody) {
      try {
        payload = JSON.parse(rawBody);
      } catch {
        payload = { message: rawBody };
      }
    } else {
      payload = {};
    }

    if (!response.ok) {
      const errorPayload = isObject(payload) ? payload : {};
      const message = typeof errorPayload.error === "string"
        ? errorPayload.error
        : typeof errorPayload.message === "string"
          ? errorPayload.message
          : `JobAI request failed with status ${response.status}`;
      throw new HttpError(response.status, message, errorPayload);
    }

    return payload as T;
  }

  private buildHeaders(input?: HeadersInit): Headers {
    const headers = new Headers(input);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    if (env.JOBAI_API_AUTH_MODE === "bearer" && env.JOBAI_API_TOKEN) {
      headers.set("Authorization", `Bearer ${env.JOBAI_API_TOKEN}`);
    }

    if (env.JOBAI_API_AUTH_MODE === "basic" && env.JOBAI_API_BASIC_USER && env.JOBAI_API_BASIC_PASSWORD) {
      const encoded = Buffer.from(`${env.JOBAI_API_BASIC_USER}:${env.JOBAI_API_BASIC_PASSWORD}`, "utf-8").toString(
        "base64"
      );
      headers.set("Authorization", `Basic ${encoded}`);
    }

    return headers;
  }

  private extractInterview(payload: JsonRecord): JobAiInterview {
    if (!isObject(payload.interview)) {
      throw new HttpError(502, "Invalid JobAI response payload");
    }
    return payload.interview as unknown as JobAiInterview;
  }
}
