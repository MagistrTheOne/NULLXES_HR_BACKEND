import { env, resolveArachnePodEngine, resolveAvatarInferenceServiceKey } from "../config/env";
import { logger } from "../logging/logger";

export type ArachneFrameEncoding = "rgb24_base64";

export interface ArachneAvatarFrameRequest {
  sessionId: string;
  imageBase64: string;
  prompt?: string;
  audioPcm16Base64?: string;
  audioFloat32Base64?: string;
  negativePrompt?: string;
  numInferenceSteps?: number;
  textGuidanceScale?: number;
  audioGuidanceScale?: number;
  resolution?: string;
  numFrames?: number;
  engine?: string;
}

export interface ArachneAvatarFrame {
  seq: number;
  tsMs: number;
  encoding: ArachneFrameEncoding;
  width: number;
  height: number;
  frameBase64: string;
}

export type ArachneAvatarFrameResult =
  | { ok: true; frame: ArachneAvatarFrame; i420: Buffer }
  | { ok: false; error: string; raw?: unknown };

export class ArachneAvatarFramesClient {
  private readonly baseUrl?: string;
  private readonly framesPath: string;
  private readonly timeoutMs: number;
  private readonly inferenceKey?: string;
  private lastError: string | null = null;

  constructor() {
    this.baseUrl = env.AVATAR_POD_URL?.replace(/\/+$/, "");
    this.framesPath = env.AVATAR_FRAMES_PATH.startsWith("/")
      ? env.AVATAR_FRAMES_PATH
      : `/${env.AVATAR_FRAMES_PATH}`;
    this.timeoutMs = env.AVATAR_FRAMES_TIMEOUT_MS;
    this.inferenceKey = resolveAvatarInferenceServiceKey();
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  getLastError(): string | null {
    return this.lastError;
  }

  async probeHealth(): Promise<{ ok: boolean; status?: number; detail?: unknown; latencyMs?: number; engine: string; lastError?: string }> {
    if (!this.baseUrl) {
      return { ok: false, detail: "AVATAR_POD_URL is not configured", engine: resolveArachnePodEngine(), lastError: this.lastError ?? undefined };
    }
    const startedAt = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000))
      });
      const latencyMs = Date.now() - startedAt;
      const text = await res.text().catch(() => "");
      let detail: unknown = text;
      try {
        detail = text ? JSON.parse(text) : undefined;
      } catch {
        detail = text;
      }
      if (!res.ok) {
        this.lastError = typeof detail === "string" ? detail : `HTTP ${res.status}`;
        return { ok: false, status: res.status, detail, latencyMs, engine: resolveArachnePodEngine(), lastError: this.lastError };
      }
      this.lastError = null;
      return { ok: true, status: res.status, detail, latencyMs, engine: resolveArachnePodEngine() };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      return { ok: false, detail: message, latencyMs, engine: resolveArachnePodEngine(), lastError: message };
    }
  }

  async *streamFrames(input: ArachneAvatarFrameRequest, signal?: AbortSignal): AsyncGenerator<ArachneAvatarFrameResult> {
    if (!this.baseUrl) {
      const error = "AVATAR_POD_URL is not configured";
      this.lastError = error;
      yield { ok: false, error };
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const url = `${this.baseUrl}${this.framesPath}`;

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson"
      };
      if (this.inferenceKey) {
        headers["x-nullxes-avatar-inference-key"] = this.inferenceKey;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          engine: resolveArachnePodEngine(),
          numInferenceSteps: 8,
          textGuidanceScale: 4.0,
          audioGuidanceScale: 4.0,
          resolution: "480p",
          numFrames: 25,
          ...input
        }),
        signal: controller.signal
      });

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        const error = `ARACHNE avatar_frames returned ${response.status}: ${text.slice(0, 300)}`;
        this.lastError = error;
        yield { ok: false, error };
        return;
      }

      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffered = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line) {
            yield this.parseLine(line);
          }
          newline = buffered.indexOf("\n");
        }
      }
      const tail = buffered.trim();
      if (tail) {
        yield this.parseLine(tail);
      }
      this.lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      logger.warn({ err, url }, "arachne avatar_frames request failed");
      yield { ok: false, error: message };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private parseLine(line: string): ArachneAvatarFrameResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ok: false, error: "invalid_ndjson_json", raw: line };
    }
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "invalid_ndjson_object", raw: parsed };
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error.trim()) {
      this.lastError = obj.error.trim();
      return { ok: false, error: obj.error.trim(), raw: parsed };
    }
    const frame = parseFrame(obj);
    if (!frame) {
      return { ok: false, error: "invalid_frame_payload", raw: parsed };
    }
    try {
      const i420 = rgb24Base64ToI420(frame.frameBase64, frame.width, frame.height);
      return { ok: true, frame, i420 };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), raw: parsed };
    }
  }
}

function parseFrame(obj: Record<string, unknown>): ArachneAvatarFrame | null {
  const seq = typeof obj.seq === "number" ? obj.seq : null;
  const tsMs = typeof obj.tsMs === "number" ? obj.tsMs : null;
  const encoding = obj.encoding === "rgb24_base64" ? obj.encoding : null;
  const width = typeof obj.width === "number" ? obj.width : null;
  const height = typeof obj.height === "number" ? obj.height : null;
  const frameBase64 = typeof obj.frameBase64 === "string" ? obj.frameBase64 : null;
  if (seq == null || tsMs == null || encoding == null || width == null || height == null || !frameBase64) return null;
  return { seq, tsMs, encoding, width, height, frameBase64 };
}

function rgb24Base64ToI420(frameBase64: string, width: number, height: number): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("invalid frame dimensions");
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error("rgb24 to I420 conversion requires even frame dimensions");
  }
  const rgb = Buffer.from(frameBase64, "base64");
  const expected = width * height * 3;
  if (rgb.length !== expected) {
    throw new Error(`invalid rgb24 payload size: got ${rgb.length}, expected ${expected}`);
  }
  const ySize = width * height;
  const uvWidth = Math.ceil(width / 2);
  const uvHeight = Math.ceil(height / 2);
  const uvSize = uvWidth * uvHeight;
  const out = Buffer.alloc(ySize + uvSize * 2);
  const yOffset = 0;
  const uOffset = ySize;
  const vOffset = ySize + uvSize;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgbIdx = (y * width + x) * 3;
      const r = rgb[rgbIdx] ?? 0;
      const g = rgb[rgbIdx + 1] ?? 0;
      const b = rgb[rgbIdx + 2] ?? 0;
      out[yOffset + y * width + x] = clampByte(0.257 * r + 0.504 * g + 0.098 * b + 16);
    }
  }

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let uSum = 0;
      let vSum = 0;
      let count = 0;
      for (let yy = y; yy < Math.min(y + 2, height); yy += 1) {
        for (let xx = x; xx < Math.min(x + 2, width); xx += 1) {
          const rgbIdx = (yy * width + xx) * 3;
          const r = rgb[rgbIdx] ?? 0;
          const g = rgb[rgbIdx + 1] ?? 0;
          const b = rgb[rgbIdx + 2] ?? 0;
          uSum += -0.148 * r - 0.291 * g + 0.439 * b + 128;
          vSum += 0.439 * r - 0.368 * g - 0.071 * b + 128;
          count += 1;
        }
      }
      const uvIndex = Math.floor(y / 2) * uvWidth + Math.floor(x / 2);
      out[uOffset + uvIndex] = clampByte(uSum / count);
      out[vOffset + uvIndex] = clampByte(vSum / count);
    }
  }

  return out;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
