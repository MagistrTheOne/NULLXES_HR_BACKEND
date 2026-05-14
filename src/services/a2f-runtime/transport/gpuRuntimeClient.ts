import { WebSocket } from "ws";
import { logger } from "../../../logging/logger";
import type {
  AudioChunk,
  RuntimeFrameEnvelope,
  RuntimeFrameSubscriber,
  RuntimeIngestResult,
  RuntimeSessionConfig,
  SessionRuntimeStats
} from "../contracts";
import type { A2FRuntimeClient } from "../runtimeServiceClient";

type GpuRuntimeClientOptions = {
  wsBaseUrl: string;
  heartbeatMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxBufferedChunks?: number;
  podHealthcheckUrl?: string;
  podHealthcheckTimeoutMs?: number;
};

type GpuSession = {
  meetingId: string;
  config: RuntimeSessionConfig;
  ws: WebSocket | null;
  connected: boolean;
  stopped: boolean;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  pending: OutboundMessage[];
  subscribers: Set<RuntimeFrameSubscriber>;
  stats: {
    totalFrames: number;
    droppedFrames: number;
    droppedSamples: number;
    reconnects: number;
    queueDepthMs: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    fps: number;
    outputQueueDepth: number;
    lastFrameAtMs: number;
  };
  /** Recent per-frame latency samples (ms) for avg / p95; separate from FPS window. */
  latencySamples: number[];
  /** Wall-clock ms of frame arrivals in the last ~5s sliding window for FPS. */
  fpsArrivalTimesMs: number[];
};

type OutboundMessage =
  | { type: "session.start"; payload: Record<string, unknown> }
  | { type: "session.stop"; payload: Record<string, unknown> }
  | { type: "audio.chunk"; payload: Record<string, unknown> }
  | { type: "ping"; payload: Record<string, unknown> };

type PodIncoming =
  | { type: "session.started"; meetingId: string }
  | { type: "session.stopped"; meetingId: string }
  | { type: "facial.frame"; meetingId: string; frame: RuntimeFrameEnvelope }
  | {
      type: "runtime.stats";
      meetingId: string;
      stats: Partial<{
        fps: number;
        queueDepthMs: number;
        avgLatencyMs: number;
        p95LatencyMs: number;
        droppedFrames: number;
        outputQueueDepth: number;
      }>;
    }
  | { type: "error"; meetingId?: string; message?: string; detail?: unknown }
  | { type: "pong"; ts?: number };

export class GpuRuntimeClient implements A2FRuntimeClient {
  private readonly sessions = new Map<string, GpuSession>();
  private podHealthy = 0;

  constructor(private readonly options: GpuRuntimeClientOptions) {}

  startSession(config: RuntimeSessionConfig): void {
    if (this.sessions.has(config.meetingId)) {
      return;
    }
    const session: GpuSession = {
      meetingId: config.meetingId,
      config,
      ws: null,
      connected: false,
      stopped: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      heartbeatTimer: null,
      pending: [],
      subscribers: new Set(),
      stats: {
        totalFrames: 0,
        droppedFrames: 0,
        droppedSamples: 0,
        reconnects: 0,
        queueDepthMs: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        fps: 0,
        outputQueueDepth: 0,
        lastFrameAtMs: 0
      },
      latencySamples: [],
      fpsArrivalTimesMs: []
    };
    this.sessions.set(config.meetingId, session);
    this.connectSession(session);
  }

  stopSession(meetingId: string): void {
    const session = this.sessions.get(meetingId);
    if (!session) {
      return;
    }
    session.stopped = true;
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
      session.heartbeatTimer = null;
    }
    this.enqueue(session, {
      type: "session.stop",
      payload: { meetingId }
    });
    this.flushPending(session);
    session.ws?.close();
    session.ws = null;
    session.connected = false;
    for (const sub of session.subscribers) {
      sub.onClose?.();
    }
    this.sessions.delete(meetingId);
  }

  ingestChunk(meetingId: string, chunk: AudioChunk): RuntimeIngestResult {
    const session = this.sessions.get(meetingId);
    if (!session || session.stopped) {
      return { acceptedSamples: 0, droppedSamples: 0, queueDepthMs: 0 };
    }
    const payload = {
      meetingId,
      timestampMs: chunk.timestampMs,
      sampleRateHz: chunk.sampleRateHz,
      pcm16Base64: Buffer.from(chunk.pcm16.buffer, chunk.pcm16.byteOffset, chunk.pcm16.byteLength).toString("base64")
    };
    const droppedByQueue = this.enqueue(session, { type: "audio.chunk", payload });
    if (droppedByQueue > 0) {
      session.stats.droppedSamples += droppedByQueue;
    }
    this.flushPending(session);

    const queueDepthMs = this.estimateQueueDepthMs(session);
    session.stats.queueDepthMs = queueDepthMs;
    return {
      acceptedSamples: chunk.pcm16.length,
      droppedSamples: droppedByQueue,
      queueDepthMs
    };
  }

  subscribe(meetingId: string, subscriber: RuntimeFrameSubscriber): () => void {
    const session = this.sessions.get(meetingId);
    if (!session) {
      return () => undefined;
    }
    session.subscribers.add(subscriber);
    return () => {
      session.subscribers.delete(subscriber);
      subscriber.onClose?.();
    };
  }

  getStats(meetingId: string): SessionRuntimeStats | null {
    const session = this.sessions.get(meetingId);
    if (!session) {
      return null;
    }
    return {
      meetingId,
      active: session.connected && !session.stopped,
      fps: Number(session.stats.fps.toFixed(2)),
      queueDepthMs: session.stats.queueDepthMs,
      avgLatencyMs: session.stats.avgLatencyMs,
      p95LatencyMs: session.stats.p95LatencyMs,
      droppedFrames: session.stats.droppedFrames,
      droppedSamples: session.stats.droppedSamples,
      totalFrames: session.stats.totalFrames,
      outputQueueDepth: session.stats.outputQueueDepth,
      gpuSlot: 0
    };
  }

  listStats(): SessionRuntimeStats[] {
    return Array.from(this.sessions.keys())
      .map((meetingId) => this.getStats(meetingId))
      .filter((item): item is SessionRuntimeStats => item !== null);
  }

  getReconnectsTotal(): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      total += session.stats.reconnects;
    }
    return total;
  }

  getDroppedFramesTotal(): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      total += session.stats.droppedFrames;
    }
    return total;
  }

  getPodHealthState(): number {
    return this.podHealthy;
  }

  async checkPodHealth(): Promise<boolean> {
    if (!this.options.podHealthcheckUrl) {
      this.podHealthy = 1;
      return true;
    }
    const timeoutMs = this.options.podHealthcheckTimeoutMs ?? 3000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.options.podHealthcheckUrl, { signal: controller.signal });
      this.podHealthy = res.ok ? 1 : 0;
      return res.ok;
    } catch {
      this.podHealthy = 0;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private connectSession(session: GpuSession): void {
    if (session.stopped) {
      return;
    }
    const wsUrl = new URL(this.options.wsBaseUrl);
    wsUrl.searchParams.set("meetingId", session.meetingId);
    const ws = new WebSocket(wsUrl.toString());
    session.ws = ws;

    ws.on("open", () => {
      session.connected = true;
      session.reconnectAttempts = 0;
      this.enqueue(session, {
        type: "session.start",
        payload: {
          meetingId: session.meetingId,
          sampleRateHz: 16_000,
          targetFps: session.config.targetFps ?? 30,
          windowMs: session.config.windowMs ?? 40,
          hopMs: session.config.hopMs ?? 20,
          maxQueueMs: session.config.maxQueueMs ?? 200
        }
      });
      this.flushPending(session);
      this.startHeartbeat(session);
      logger.info({ meetingId: session.meetingId }, "gpu runtime websocket connected");
    });

    ws.on("message", (buf: Buffer) => {
      this.handleIncoming(session, buf.toString("utf8"));
    });

    ws.on("close", () => {
      this.handleDisconnect(session, "close");
    });

    ws.on("error", (error) => {
      logger.warn({ meetingId: session.meetingId, err: error }, "gpu runtime websocket error");
      this.handleDisconnect(session, "error");
    });
  }

  private handleIncoming(session: GpuSession, raw: string): void {
    let parsed: PodIncoming | null = null;
    try {
      parsed = JSON.parse(raw) as PodIncoming;
    } catch {
      logger.warn({ meetingId: session.meetingId }, "gpu runtime payload parse failed");
      return;
    }
    if (!parsed) {
      return;
    }
    if (parsed.type === "facial.frame") {
      this.handleFrame(session, parsed.frame);
      return;
    }
    if (parsed.type === "runtime.stats") {
      const s = parsed.stats;
      if (typeof s.fps === "number") session.stats.fps = s.fps;
      if (typeof s.queueDepthMs === "number") session.stats.queueDepthMs = s.queueDepthMs;
      if (typeof s.avgLatencyMs === "number") session.stats.avgLatencyMs = s.avgLatencyMs;
      if (typeof s.p95LatencyMs === "number") session.stats.p95LatencyMs = s.p95LatencyMs;
      if (typeof s.droppedFrames === "number") session.stats.droppedFrames = s.droppedFrames;
      if (typeof s.outputQueueDepth === "number") session.stats.outputQueueDepth = s.outputQueueDepth;
      return;
    }
    if (parsed.type === "error") {
      logger.warn({ meetingId: session.meetingId, detail: parsed.detail, message: parsed.message }, "gpu runtime error");
    }
  }

  private handleFrame(session: GpuSession, frame: RuntimeFrameEnvelope): void {
    session.stats.totalFrames += 1;
    session.stats.lastFrameAtMs = Date.now();
    this.updateLatencyStats(session, frame.latencyMs);
    this.updateFps(session);
    for (const subscriber of session.subscribers) {
      if (subscriber.format === "protobuf") {
        subscriber.onFrame(Buffer.from(JSON.stringify(frame), "utf8"));
      } else {
        subscriber.onFrame(frame);
      }
    }
  }

  private handleDisconnect(session: GpuSession, reason: string): void {
    if (session.stopped) {
      return;
    }
    session.connected = false;
    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
      session.heartbeatTimer = null;
    }
    const maxDelay = this.options.reconnectMaxMs ?? 10_000;
    const baseDelay = this.options.reconnectBaseMs ?? 500;
    const jitter = Math.floor(Math.random() * 250);
    const delay = Math.min(maxDelay, baseDelay * 2 ** session.reconnectAttempts) + jitter;
    session.reconnectAttempts += 1;
    session.stats.reconnects += 1;
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
    }
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      this.connectSession(session);
    }, delay);
    logger.warn({ meetingId: session.meetingId, reason, reconnectInMs: delay }, "gpu runtime disconnected; reconnect scheduled");
  }

  private startHeartbeat(session: GpuSession): void {
    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
    }
    const heartbeatMs = this.options.heartbeatMs ?? 5000;
    session.heartbeatTimer = setInterval(() => {
      this.enqueue(session, {
        type: "ping",
        payload: { ts: Date.now(), meetingId: session.meetingId }
      });
      this.flushPending(session);
    }, heartbeatMs);
    session.heartbeatTimer.unref();
  }

  private enqueue(session: GpuSession, msg: OutboundMessage): number {
    const limit = this.options.maxBufferedChunks ?? 128;
    session.pending.push(msg);
    let dropped = 0;
    while (session.pending.length > limit) {
      const removed = session.pending.shift();
      if (removed?.type === "audio.chunk") {
        dropped += 320;
      } else {
        session.stats.droppedFrames += 1;
      }
    }
    session.stats.outputQueueDepth = session.pending.length;
    return dropped;
  }

  private flushPending(session: GpuSession): void {
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    while (session.pending.length > 0) {
      const next = session.pending.shift();
      if (!next) {
        continue;
      }
      session.ws.send(JSON.stringify(next));
    }
    session.stats.outputQueueDepth = 0;
  }

  private estimateQueueDepthMs(session: GpuSession): number {
    if (session.pending.length === 0) {
      return 0;
    }
    const hopMs = session.config.hopMs ?? 20;
    return session.pending.length * hopMs;
  }

  private updateLatencyStats(session: GpuSession, latencyMs: number): void {
    const prevAvg = session.stats.avgLatencyMs;
    const n = session.stats.totalFrames;
    session.stats.avgLatencyMs = prevAvg + (latencyMs - prevAvg) / Math.max(1, n);
    const list = session.latencySamples;
    list.push(latencyMs);
    if (list.length > 256) {
      list.splice(0, list.length - 256);
    }
    const sorted = [...list].sort((a, b) => a - b);
    const p95idx = Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)));
    session.stats.p95LatencyMs = sorted[p95idx] ?? latencyMs;
  }

  private updateFps(session: GpuSession): void {
    const now = Date.now();
    const arrivals = session.fpsArrivalTimesMs;
    arrivals.push(now);
    while (arrivals.length > 0 && now - (arrivals[0] ?? now) > 5000) {
      arrivals.shift();
    }
    session.stats.fps = Number((arrivals.length / 5).toFixed(2));
  }
}
