import { randomUUID } from "node:crypto";
import { logger } from "../logging/logger";
import { recordAvatarGenerateSuccess } from "./avatarGenerateHeartbeat";
import type { AvatarGenerateJobRecord, AvatarGenerateJobStore } from "./avatarGenerateJobStore";
import type { MinimalRedisClient } from "./redisClient";

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const AUDIO_MAX_BYTES = 20 * 1024 * 1024;
const MAX_RUNPOD_ATTEMPTS = 3;

function normalizeRunpodBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function joinPublicAssetUrl(base: string, pathOrUrl: string): string {
  const trimmed = pathOrUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const b = normalizeRunpodBase(base);
  const p = trimmed.replace(/^\/+/, "");
  return `${b}/${p}`;
}

function extractLegacyVideoPathOrUrl(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as Record<string, unknown>;
  const keys = ["video_url", "output_url", "videoUrl", "outputUrl", "url"];
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const result = o.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    for (const k of keys) {
      const v = r[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return undefined;
}

function extractRunpodResultPath(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as Record<string, unknown>;
  const result = o.result;
  if (!Array.isArray(result) || result.length === 0) return undefined;
  const first = result[0];
  if (typeof first !== "string" || !first.trim()) return undefined;
  return first.trim();
}

function resolvePublicVideoUrl(runpodBaseUrl: string, json: unknown): { videoUrl?: string; error?: string } {
  const fromArray = extractRunpodResultPath(json);
  if (fromArray) {
    return { videoUrl: joinPublicAssetUrl(runpodBaseUrl, fromArray) };
  }
  const legacy = extractLegacyVideoPathOrUrl(json);
  if (legacy) {
    return { videoUrl: joinPublicAssetUrl(runpodBaseUrl, legacy) };
  }
  return { error: "response missing video path (expected result[0] or known URL fields)" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoNow(): string {
  return new Date().toISOString();
}

export type UploadedGenerateFiles = {
  image: { buffer: Buffer; mimetype: string; originalname: string };
  audio: { buffer: Buffer; mimetype: string; originalname: string };
  prompt: string;
};

export class AvatarGenerateRunpodService {
  constructor(
    private readonly deps: {
      jobStore: AvatarGenerateJobStore;
      runpodBaseUrl: string;
      generateTimeoutMs: number;
      wallClockMs: number;
      retryBackoffMs: [number, number];
      redis?: MinimalRedisClient;
      redisPrefix: string;
      heartbeatTtlMs: number;
    }
  ) {}

  validateUploads(files: UploadedGenerateFiles): { ok: true } | { ok: false; message: string } {
    if (files.image.buffer.length > IMAGE_MAX_BYTES) {
      return { ok: false, message: `image exceeds max size (${IMAGE_MAX_BYTES} bytes)` };
    }
    if (files.audio.buffer.length > AUDIO_MAX_BYTES) {
      return { ok: false, message: `audio exceeds max size (${AUDIO_MAX_BYTES} bytes)` };
    }
    if (!files.prompt.trim()) {
      return { ok: false, message: "prompt is required" };
    }
    return { ok: true };
  }

  async enqueue(files: UploadedGenerateFiles): Promise<{ jobId: string }> {
    const check = this.validateUploads(files);
    if (!check.ok) {
      throw new Error(check.message);
    }
    const jobId = randomUUID();
    const now = Date.now();
    const startedAt = new Date(now).toISOString();
    const job: AvatarGenerateJobRecord = {
      id: jobId,
      state: "queued",
      createdAtMs: now,
      updatedAtMs: now,
      startedAt,
      retryCount: 0,
      prompt: files.prompt.trim()
    };
    await this.deps.jobStore.save(job);
    void this.runJob(jobId, files).catch((err) => {
      logger.error({ err, jobId }, "avatar generate job crashed");
    });
    return { jobId };
  }

  private async runJob(jobId: string, files: UploadedGenerateFiles): Promise<void> {
    const base = normalizeRunpodBase(this.deps.runpodBaseUrl);
    const target = `${base}/generate`;
    const [backoff1, backoff2] = this.deps.retryBackoffMs;

    const patch = async (partial: Partial<AvatarGenerateJobRecord>): Promise<void> => {
      const current = await this.deps.jobStore.get(jobId);
      if (!current) return;
      const next: AvatarGenerateJobRecord = {
        ...current,
        ...partial,
        updatedAtMs: Date.now()
      };
      await this.deps.jobStore.save(next);
    };

    const job0 = await this.deps.jobStore.get(jobId);
    if (!job0) return;
    const startedMs = job0.startedAt ? Date.parse(job0.startedAt) : job0.createdAtMs;
    const wallDeadline = startedMs + this.deps.wallClockMs;

    await patch({
      state: "processing",
      processingStartedAt: job0.processingStartedAt ?? isoNow()
    });

    let lastError = "generation_failed";

    for (let attempt = 0; attempt < MAX_RUNPOD_ATTEMPTS; attempt++) {
      if (Date.now() > wallDeadline) {
        await patch({
          state: "failed",
          failedAt: isoNow(),
          errorMessage: "generation_timeout",
          retryCount: attempt
        });
        return;
      }

      if (attempt === 1) {
        await sleep(backoff1);
      } else if (attempt === 2) {
        await sleep(backoff2);
      }

      if (Date.now() > wallDeadline) {
        await patch({
          state: "failed",
          failedAt: isoNow(),
          errorMessage: "generation_timeout",
          retryCount: attempt
        });
        return;
      }

      const remaining = wallDeadline - Date.now();
      if (remaining < 500) {
        await patch({
          state: "failed",
          failedAt: isoNow(),
          errorMessage: "generation_timeout",
          retryCount: attempt
        });
        return;
      }

      const perRequestMs = Math.min(this.deps.generateTimeoutMs, remaining);

      try {
        const form = new FormData();
        const imageBlob = new Blob([new Uint8Array(files.image.buffer)], {
          type: files.image.mimetype || "application/octet-stream"
        });
        const audioBlob = new Blob([new Uint8Array(files.audio.buffer)], {
          type: files.audio.mimetype || "application/octet-stream"
        });
        form.append("image", imageBlob, files.image.originalname || "image");
        form.append("audio", audioBlob, files.audio.originalname || "audio");
        form.append("prompt", files.prompt);

        const response = await fetch(target, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(perRequestMs)
        });

        const text = await response.text();
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          json = { raw: text };
        }

        if (!response.ok) {
          lastError = `RunPod HTTP ${response.status}: ${text.slice(0, 400)}`;
          if (attempt === MAX_RUNPOD_ATTEMPTS - 1) {
            await patch({
              state: "failed",
              failedAt: isoNow(),
              errorMessage: lastError,
              retryCount: attempt + 1
            });
          } else {
            await patch({ retryCount: attempt + 1 });
          }
          continue;
        }

        const gpu = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
        const gpuStatus = gpu.status;
        if (gpuStatus === "failed" || gpuStatus === "error") {
          const msg =
            typeof gpu.message === "string" && gpu.message.trim()
              ? gpu.message.trim()
              : `RunPod reported status: ${String(gpuStatus)}`;
          await patch({
            state: "failed",
            failedAt: isoNow(),
            errorMessage: msg,
            retryCount: attempt
          });
          return;
        }

        const resolved = resolvePublicVideoUrl(base, json);
        if (!resolved.videoUrl) {
          await patch({
            state: "failed",
            failedAt: isoNow(),
            errorMessage: resolved.error ?? "could not build video URL from RunPod response",
            retryCount: attempt
          });
          return;
        }

        const doneAt = isoNow();
        await patch({
          state: "hydrating",
          videoUrl: resolved.videoUrl,
          resultVideoUrl: resolved.videoUrl,
          resultPayload: json,
          retryCount: attempt
        });
        await patch({
          state: "completed",
          completedAt: doneAt,
          videoUrl: resolved.videoUrl,
          resultVideoUrl: resolved.videoUrl,
          resultPayload: json,
          retryCount: attempt
        });
        await recordAvatarGenerateSuccess(this.deps.redis, this.deps.redisPrefix, this.deps.heartbeatTtlMs);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === MAX_RUNPOD_ATTEMPTS - 1) {
          await patch({
            state: "failed",
            failedAt: isoNow(),
            errorMessage: lastError,
            retryCount: attempt + 1
          });
        } else {
          await patch({ retryCount: attempt + 1 });
        }
      }
    }
  }

  async probeHealth(): Promise<{ ok: boolean; status?: number; detail?: string; latencyMs?: number }> {
    const base = normalizeRunpodBase(this.deps.runpodBaseUrl);
    /** RunPod / external GPU often exposes `GET /warmup` with `{ status, gpu, latencyMs }`. */
    const candidates = [`${base}/warmup`, `${base}/health`, `${base}/`];
    let lastLatencyMs: number | undefined;
    let lastHttpDetail = "";

    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i];
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(5000)
        });
        const elapsed = Date.now() - t0;
        lastLatencyMs = elapsed;
        const text = await res.text().catch(() => "");
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }

        if (!res.ok) {
          lastHttpDetail = text.slice(0, 300);
          if (i < candidates.length - 1) {
            continue;
          }
          return {
            ok: false,
            status: res.status,
            detail: lastHttpDetail,
            latencyMs: lastLatencyMs
          };
        }

        const warmSchemaOk = isRunpodWarmupHealthy(json);
        const reported = extractWarmupLatencyMs(json);

        if (warmSchemaOk) {
          return {
            ok: true,
            status: res.status,
            latencyMs: reported != null ? reported : elapsed
          };
        }

        // Legacy runtimes: HTTP 200 on /health or / without JSON warmup shape
        return { ok: true, status: res.status, latencyMs: reported ?? elapsed };
      } catch (e) {
        lastLatencyMs = Date.now() - t0;
        const detail = e instanceof Error ? e.message : String(e);
        if (i >= candidates.length - 1) {
          return { ok: false, detail, latencyMs: lastLatencyMs };
        }
      }
    }
    return { ok: false, detail: "unreachable", latencyMs: lastLatencyMs };
  }
}

function isRunpodWarmupHealthy(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const o = json as Record<string, unknown>;
  return o.status === "warm" || o.gpu === "ready";
}

function extractWarmupLatencyMs(json: unknown): number | undefined {
  if (!json || typeof json !== "object") return undefined;
  const lm = (json as Record<string, unknown>).latencyMs;
  if (typeof lm === "number" && Number.isFinite(lm)) {
    return lm;
  }
  return undefined;
}
