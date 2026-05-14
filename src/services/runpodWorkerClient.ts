import { env } from "../config/env";
import { logger } from "../logging/logger";

export type RunpodGenerateClipRequest = {
  sessionId: string;
  meetingId: string;
  epoch: number;
  audioPcm16Base64: string;
  audioSampleRate: 16000 | 24000 | 48000;
  refImageBase64?: string;
  avatarKey?: string;
  fps: 25;
  width: number;
  height: number;
  numFrames: 25 | 49 | 57 | 105;
  numInferenceSteps: 3 | 5;
  seed?: number;
  prompt: string;
  negativePrompt: string;
  returnFrames?: boolean;
};

export type RunpodGenerateClipResponse = {
  sessionId: string;
  meetingId: string;
  epoch: number;
  fps: number;
  width: number;
  height: number;
  frames: Array<{ ptsMs: number; i420Base64: string }>;
  telemetry: {
    model: string;
    clipLatencyMs: number;
    queueDepth: number;
    gpuMemoryMb?: number;
    numFrames: number;
    numInferenceSteps: number;
  };
};

export type RunpodGenerateClipDegradedReason =
  | "worker_timeout"
  | "worker_http_error"
  | "worker_invalid_response"
  | "worker_error"
  | "worker_done_without_frames"
  | "worker_unconfigured";

export type RunpodGenerateClipResult =
  | ({ ok: true } & RunpodGenerateClipResponse)
  | {
      ok: false;
      degraded: true;
      reason: RunpodGenerateClipDegradedReason;
      error?: unknown;
      telemetry?: Record<string, unknown>;
      workerStatus?: string;
      workerLatencyMs?: number;
    };

export class RunpodWorkerClient {
  private readonly baseUrl?: string;
  private readonly timeoutMs: number;
  private readonly mode: "sync" | "async";
  private readonly pollIntervalMs: number;
  private readonly jobTimeoutMs: number;

  constructor() {
    this.baseUrl = env.RUNPOD_WORKER_URL?.replace(/\/+$/, "");
    this.timeoutMs = env.RUNPOD_WORKER_TIMEOUT_MS;
    this.mode = env.RUNPOD_WORKER_MODE;
    this.pollIntervalMs = env.RUNPOD_WORKER_POLL_INTERVAL_MS;
    this.jobTimeoutMs = env.RUNPOD_WORKER_JOB_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  async checkHealth(): Promise<{ ok: boolean; status?: number; detail?: unknown; latencyMs?: number }> {
    if (!this.baseUrl) {
      return { ok: false, detail: "RUNPOD_WORKER_URL is not configured" };
    }
    const startedAt = Date.now();
    const response = await this.safeJsonFetch(`${this.baseUrl}/health`, { method: "GET" });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return { ok: false, detail: response.error, latencyMs };
    }
    return { ok: true, detail: response.data, latencyMs };
  }

  async generateClip(input: RunpodGenerateClipRequest): Promise<RunpodGenerateClipResponse> {
    if (!this.baseUrl) {
      throw new Error("RUNPOD_WORKER_URL is not configured");
    }
    const url = `${this.baseUrl}/generate_clip`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        logger.warn({ url, status: response.status, body: text.slice(0, 500) }, "runpod worker generate_clip failed");
        throw new Error(`runpod worker returned ${response.status}: ${text.slice(0, 200)}`);
      }
      return JSON.parse(text) as RunpodGenerateClipResponse;
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`runpod worker timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  async generateClipBestEffort(input: RunpodGenerateClipRequest): Promise<RunpodGenerateClipResult> {
    if (!this.baseUrl) {
      return { ok: false, degraded: true, reason: "worker_unconfigured" };
    }
    if (this.mode === "async") {
      return await this.generateClipAsyncBestEffort(input);
    }
    // sync mode: wrap errors as degraded instead of throwing.
    try {
      const out = await this.generateClip(input);
      return { ok: true, ...out };
    } catch (err) {
      logger.warn({ err }, "worker_degraded (sync)");
      return { ok: false, degraded: true, reason: "worker_http_error", error: err };
    }
  }

  private async generateClipAsyncBestEffort(input: RunpodGenerateClipRequest): Promise<RunpodGenerateClipResult> {
    const baseUrl = this.baseUrl!;
    const createUrl = `${baseUrl}/generate_clip_async`;
    const returnFrames = input.returnFrames ?? env.RUNPOD_WORKER_RETURN_FRAMES;
    const createBody = { ...input, returnFrames };

    const startedAt = Date.now();
    logger.info(
      {
        event: "worker_job_started",
        createUrl,
        meetingId: input.meetingId,
        sessionId: input.sessionId,
        epoch: input.epoch,
        numFrames: input.numFrames,
        numInferenceSteps: input.numInferenceSteps
      },
      "worker_job_started"
    );

    const create = await this.safeJsonFetch(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody)
    });
    if (!create.ok) {
      logger.warn({ event: "worker_job_error", reason: create.reason, error: create.error }, "worker_job_error");
      return { ok: false, degraded: true, reason: create.reason, error: create.error, workerStatus: "create_failed" };
    }

    const jobId = (create.data as any)?.jobId as string | undefined;
    const status = (create.data as any)?.status as string | undefined;
    if (!jobId || status !== "queued") {
      logger.warn({ event: "worker_invalid_response", create: create.data }, "worker_invalid_response");
      return { ok: false, degraded: true, reason: "worker_invalid_response", error: create.data, workerStatus: "bad_create" };
    }

    const pollUrl = `${baseUrl}/jobs/${jobId}`;
    const deadline = Date.now() + this.jobTimeoutMs;

    while (Date.now() < deadline) {
      const poll = await this.safeJsonFetch(pollUrl, { method: "GET" });
      const workerLatencyMs = Date.now() - startedAt;

      logger.info(
        { event: "worker_job_poll", jobId, ok: poll.ok, status: poll.ok ? (poll.data as any)?.status : poll.reason },
        "worker_job_poll"
      );

      if (!poll.ok) {
        // transient polling errors should degrade but not crash.
        logger.warn({ event: "worker_job_error", jobId, reason: poll.reason, error: poll.error }, "worker_job_error");
        return {
          ok: false,
          degraded: true,
          reason: poll.reason,
          error: poll.error,
          workerStatus: "poll_failed",
          workerLatencyMs
        };
      }

      const payload = poll.data as any;
      const st = payload?.status as string | undefined;

      if (st === "queued" || st === "running") {
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      if (st === "error") {
        const telemetry = payload?.telemetry as Record<string, unknown> | undefined;
        const error = payload?.error ?? payload;
        logger.warn({ event: "worker_job_error", jobId, error, telemetry }, "worker_job_error");
        return {
          ok: false,
          degraded: true,
          reason: "worker_error",
          error,
          telemetry,
          workerStatus: "error",
          workerLatencyMs
        };
      }

      if (st === "done") {
        const telemetry = payload?.telemetry as Record<string, unknown> | undefined;
        // Contract A: frames: string[]
        const frames = payload?.frames as unknown;
        if (Array.isArray(frames) && frames.every((x) => typeof x === "string")) {
          const fps = Number(payload?.fps ?? input.fps);
          const width = Number(payload?.width ?? input.width);
          const height = Number(payload?.height ?? input.height);
          const framesOut = (frames as string[]).map((b64, idx) => ({
            ptsMs: Math.floor((idx * 1000) / fps),
            i420Base64: b64
          }));
          logger.info({ event: "worker_job_done", jobId, frames: framesOut.length }, "worker_job_done");
          return {
            ok: true,
            sessionId: input.sessionId,
            meetingId: input.meetingId,
            epoch: input.epoch,
            fps,
            width,
            height,
            frames: framesOut,
            telemetry: {
              model: String((telemetry as any)?.model ?? "arachne"),
              clipLatencyMs: Number((telemetry as any)?.clipLatencyMs ?? workerLatencyMs),
              queueDepth: Number((telemetry as any)?.queueDepth ?? 0),
              gpuMemoryMb: (telemetry as any)?.gpuMemoryMb ? Number((telemetry as any)?.gpuMemoryMb) : undefined,
              numFrames: Number((telemetry as any)?.numFrames ?? framesOut.length),
              numInferenceSteps: Number((telemetry as any)?.numInferenceSteps ?? input.numInferenceSteps)
            }
          };
        }

        // Contract B: mp4Path (no frames) => degraded typed result (do not throw).
        if (typeof payload?.mp4Path === "string") {
          logger.warn({ event: "worker_degraded", jobId, mp4Path: payload.mp4Path }, "worker_degraded");
          return {
            ok: false,
            degraded: true,
            reason: "worker_done_without_frames",
            telemetry,
            workerStatus: "done_no_frames",
            workerLatencyMs
          };
        }

        logger.warn({ event: "worker_invalid_response", jobId, payload }, "worker_invalid_response");
        return {
          ok: false,
          degraded: true,
          reason: "worker_invalid_response",
          error: payload,
          telemetry,
          workerStatus: "done_invalid",
          workerLatencyMs
        };
      }

      // Unknown status => degrade
      logger.warn({ event: "worker_invalid_response", jobId, payload }, "worker_invalid_response");
      return {
        ok: false,
        degraded: true,
        reason: "worker_invalid_response",
        error: payload,
        workerStatus: "unknown_status",
        workerLatencyMs
      };
    }

    logger.warn({ event: "worker_job_timeout", pollUrl, jobTimeoutMs: this.jobTimeoutMs }, "worker_job_timeout");
    return { ok: false, degraded: true, reason: "worker_timeout", workerStatus: "timeout", workerLatencyMs: Date.now() - startedAt };
  }

  private async safeJsonFetch(
    url: string,
    init: RequestInit
  ): Promise<
    | { ok: true; data: unknown }
    | { ok: false; reason: Exclude<RunpodGenerateClipDegradedReason, "worker_error" | "worker_done_without_frames" | "worker_unconfigured">; error?: unknown }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) {
        // Treat all non-2xx as degraded; RunPod proxy can return 524 on long jobs.
        return { ok: false, reason: "worker_http_error", error: { status: response.status, body: text.slice(0, 1000) } };
      }
      try {
        const json = JSON.parse(text);
        return { ok: true, data: json };
      } catch (err) {
        return { ok: false, reason: "worker_invalid_response", error: { err, body: text.slice(0, 1000) } };
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return { ok: false, reason: "worker_timeout", error: { url, timeoutMs: this.timeoutMs } };
      }
      return { ok: false, reason: "worker_http_error", error: { url, err } };
    } finally {
      clearTimeout(timer);
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

