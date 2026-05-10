import WebSocket from "ws";
import { env } from "../config/env";
import { logger } from "../logging/logger";
import type { RuntimeFrameEnvelope } from "./a2f-runtime/contracts";

export type EchoMimicRealtimeIngest = {
  timestampMs: number;
  sampleRateHz: number;
  pcm16Base64: string;
  a2f: RuntimeFrameEnvelope | null;
};

export type EchoMimicRealtimeFrame = {
  ptsMs: number;
  width: number;
  height: number;
  i420: Buffer;
};

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function httpToWsBase(httpsBase: string): string {
  const u = stripTrailingSlash(httpsBase);
  if (u.startsWith("https://")) return `wss://${u.slice("https://".length)}`;
  if (u.startsWith("http://")) return `ws://${u.slice("http://".length)}`;
  return u;
}

function authHeaders(): Record<string, string> {
  const token = env.RUNPOD_ECHOMIMIC_REALTIME_BEARER?.trim();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * GET /realtime/v1/health then GET /health — first 2xx wins.
 */
export async function probeEchoMimicRealtimeHealth(
  baseUrl: string
): Promise<{ ok: boolean; latencyMs?: number; detail?: unknown }> {
  const base = stripTrailingSlash(baseUrl);
  const paths = ["/realtime/v1/health", "/health"];
  for (const path of paths) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8_000);
      const res = await fetch(`${base}${path}`, {
        method: "GET",
        headers: { ...authHeaders() },
        signal: controller.signal
      });
      clearTimeout(t);
      const latencyMs = Date.now() - started;
      if (res.ok) {
        return { ok: true, latencyMs };
      }
    } catch (err) {
      logger.debug({ err, base, path }, "echomimic_realtime_health_probe_failed");
    }
  }
  return { ok: false, detail: "no_healthy_endpoint" };
}

/**
 * WebSocket client for EchoMimic 8889 — see docs/ECHOMIMIC-8889-REALTIME-WIRE.md
 */
export class EchoMimicRealtimeClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private lastFrame: EchoMimicRealtimeFrame | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private ready = false;

  isReady(): boolean {
    return this.ready && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  peekLatestFrame(): EchoMimicRealtimeFrame | null {
    return this.lastFrame;
  }

  async connect(input: {
    meetingId: string;
    sessionId: string;
    refImagePath: string;
    width: number;
    height: number;
    targetFps: number;
  }): Promise<void> {
    const base = env.RUNPOD_ECHOMIMIC_REALTIME_URL?.trim();
    if (!base) {
      throw new Error("RUNPOD_ECHOMIMIC_REALTIME_URL is not configured");
    }
    this.stopped = false;
    this.ready = false;
    await this.tryPostSession(stripTrailingSlash(base), input);
    await this.openWebSocket(httpToWsBase(base), input);
  }

  private async tryPostSession(
    base: string,
    input: { meetingId: string; sessionId: string; refImagePath: string; width: number; height: number; targetFps: number }
  ): Promise<void> {
    const url = `${base}/realtime/v1/session`;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          meetingId: input.meetingId,
          sessionId: input.sessionId,
          refImagePath: input.refImagePath,
          width: input.width,
          height: input.height,
          targetFps: input.targetFps
        }),
        signal: controller.signal
      });
      clearTimeout(t);
      if (res.status === 404) {
        logger.info({ url }, "echomimic_realtime_session_http_skipped_404");
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logger.warn({ url, status: res.status, body: text.slice(0, 400) }, "echomimic_realtime_session_http_non_ok");
        return;
      }
      logger.info({ meetingId: input.meetingId }, "echomimic_realtime_session_http_ok");
    } catch (err) {
      logger.warn({ err, url: `${base}/realtime/v1/session` }, "echomimic_realtime_session_http_failed");
    }
  }

  private async openWebSocket(
    wsOrigin: string,
    input: { meetingId: string; sessionId: string; refImagePath: string; width: number; height: number; targetFps: number }
  ): Promise<void> {
    const url = `${wsOrigin}/realtime/v1/ws`;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      const connectTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.terminate();
        reject(new Error("echomimic_realtime_ws_connect_timeout"));
      }, 15_000);

      ws.on("message", (data) => {
        this.handleMessage(data);
      });

      ws.once("open", () => {
        if (settled) return;
        clearTimeout(connectTimeout);
        const token = env.RUNPOD_ECHOMIMIC_REALTIME_BEARER?.trim();
        const hello: Record<string, unknown> = {
          type: "hello",
          meetingId: input.meetingId,
          sessionId: input.sessionId,
          refImagePath: input.refImagePath,
          width: input.width,
          height: input.height,
          targetFps: input.targetFps
        };
        if (token) {
          hello.authToken = token;
        }
        try {
          ws.send(JSON.stringify(hello));
        } catch (err) {
          settled = true;
          reject(err instanceof Error ? err : new Error("hello_send_failed"));
          return;
        }
        this.ready = true;
        this.startPing(ws);
        settled = true;
        resolve();
      });

      ws.once("error", (err) => {
        clearTimeout(connectTimeout);
        logger.warn({ err, url }, "echomimic_realtime_ws_error");
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error("echomimic_realtime_ws_error"));
        }
      });

      ws.on("close", () => {
        this.ready = false;
        this.stopPing();
        logger.info({ url }, "echomimic_realtime_ws_closed");
      });
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (Buffer.isBuffer(data)) {
      text = data.toString("utf8");
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString("utf8");
    } else {
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = msg.type;
    if (type === "frame" && typeof msg.i420Base64 === "string") {
      const width = Number(msg.width ?? 512);
      const height = Number(msg.height ?? 512);
      const ptsMs = Number(msg.ptsMs ?? Date.now());
      try {
        const i420 = Buffer.from(msg.i420Base64, "base64");
        const expected = Math.floor((width * height * 3) / 2);
        if (i420.length === expected) {
          this.lastFrame = { ptsMs, width, height, i420 };
        } else {
          logger.warn({ width, height, got: i420.length, expected }, "echomimic_realtime_frame_bad_size");
        }
      } catch {
        /* ignore */
      }
      return;
    }
    if (type === "ready") {
      logger.info({ sessionId: msg.sessionId }, "echomimic_realtime_worker_ready");
      return;
    }
    if (type === "error") {
      logger.warn({ message: msg.message }, "echomimic_realtime_worker_error_message");
      return;
    }
    if (type === "pong") {
      return;
    }
  }

  private startPing(ws: WebSocket): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.stopped || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* ignore */
      }
    }, 25_000);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  sendIngest(payload: EchoMimicRealtimeIngest): void {
    if (this.stopped || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        JSON.stringify({
          type: "ingest",
          timestampMs: payload.timestampMs,
          sampleRateHz: payload.sampleRateHz,
          pcm16Base64: payload.pcm16Base64,
          a2f: payload.a2f
        })
      );
    } catch (err) {
      logger.warn({ err }, "echomimic_realtime_ingest_send_failed");
    }
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    this.stopPing();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.lastFrame = null;
  }
}
