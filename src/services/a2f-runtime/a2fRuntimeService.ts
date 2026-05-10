import { logger } from "../../logging/logger";
import { MasterClock } from "../masterClock";
import type {
  AudioChunk,
  RuntimeFrameEnvelope,
  RuntimeFrameSubscriber,
  RuntimeIngestResult,
  RuntimeSessionConfig,
  SessionRuntimeStats
} from "./contracts";
import { LockFreePcmRingBuffer } from "./audio/lockFreePcmRingBuffer";
import { LocalA2EMExecutor, type A2EMExecutor } from "./executors/a2emExecutor";
import { LocalA2FExecutor, type A2FExecutor } from "./executors/a2fExecutor";
import { JsonBinaryFrameEncoder, type ProtobufEncoder } from "./transport/protobufEncoder";

type RuntimeSession = {
  meetingId: string;
  sampleRateHz: number;
  windowSamples: number;
  hopSamples: number;
  targetFps: number;
  maxQueueMs: number;
  ring: LockFreePcmRingBuffer;
  clock: MasterClock;
  a2f: A2FExecutor;
  a2em: A2EMExecutor;
  protobufEncoder: ProtobufEncoder;
  subscribers: Set<RuntimeFrameSubscriber>;
  inferenceTimer: NodeJS.Timeout | null;
  outputTimer: NodeJS.Timeout | null;
  outbox: RuntimeFrameEnvelope[];
  stats: {
    totalFrames: number;
    droppedFrames: number;
    latencySamples: number[];
    droppedSamples: number;
    lastFrameAtMs: number;
  };
};

export class A2FRuntimeService {
  private readonly sessions = new Map<string, RuntimeSession>();

  startSession(config: RuntimeSessionConfig): void {
    if (this.sessions.has(config.meetingId)) {
      return;
    }
    const sampleRateHz = config.sampleRateHz ?? 16_000;
    const windowMs = config.windowMs ?? 40;
    const hopMs = config.hopMs ?? 20;
    const targetFps = config.targetFps ?? 30;
    const maxQueueMs = config.maxQueueMs ?? 200;
    const session: RuntimeSession = {
      meetingId: config.meetingId,
      sampleRateHz,
      windowSamples: Math.max(1, Math.floor((windowMs * sampleRateHz) / 1000)),
      hopSamples: Math.max(1, Math.floor((hopMs * sampleRateHz) / 1000)),
      targetFps,
      maxQueueMs,
      ring: new LockFreePcmRingBuffer({ sampleRateHz, capacityMs: Math.max(500, maxQueueMs * 4) }),
      clock: new MasterClock(),
      a2f: new LocalA2FExecutor(),
      a2em: new LocalA2EMExecutor(),
      protobufEncoder: new JsonBinaryFrameEncoder(),
      subscribers: new Set(),
      inferenceTimer: null,
      outputTimer: null,
      outbox: [],
      stats: {
        totalFrames: 0,
        droppedFrames: 0,
        latencySamples: [],
        droppedSamples: 0,
        lastFrameAtMs: 0
      }
    };
    session.inferenceTimer = setInterval(() => {
      void this.runInferenceStep(session).catch((error: unknown) => {
        logger.warn({ meetingId: session.meetingId, err: error }, "a2f inference step failed");
      });
    }, Math.max(5, Math.floor(1000 / targetFps)));
    session.outputTimer = setInterval(() => {
      this.flushOutput(session);
    }, Math.max(5, Math.floor(1000 / targetFps)));
    this.sessions.set(config.meetingId, session);
  }

  stopSession(meetingId: string): void {
    const session = this.sessions.get(meetingId);
    if (!session) {
      return;
    }
    if (session.inferenceTimer) {
      clearInterval(session.inferenceTimer);
    }
    if (session.outputTimer) {
      clearInterval(session.outputTimer);
    }
    for (const subscriber of session.subscribers) {
      subscriber.onClose?.();
    }
    this.sessions.delete(meetingId);
  }

  ingestChunk(meetingId: string, chunk: AudioChunk): RuntimeIngestResult {
    const session = this.sessions.get(meetingId);
    if (!session) {
      return { acceptedSamples: 0, droppedSamples: 0, queueDepthMs: 0 };
    }
    const write = session.ring.write(chunk.pcm16);
    const depth = session.ring.getSnapshot().depthMs;
    session.stats.droppedSamples += write.dropped;
    return { acceptedSamples: write.accepted, droppedSamples: write.dropped, queueDepthMs: depth };
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
    const queueDepth = session.ring.getSnapshot().depthMs;
    const latencies = session.stats.latencySamples.slice(-200);
    return {
      meetingId,
      active: true,
      fps: this.computeFps(session),
      queueDepthMs: queueDepth,
      avgLatencyMs: average(latencies),
      p95LatencyMs: percentile(latencies, 95),
      droppedFrames: session.stats.droppedFrames,
      droppedSamples: session.stats.droppedSamples + session.ring.getDroppedSamples(),
      totalFrames: session.stats.totalFrames,
      outputQueueDepth: session.outbox.length,
      gpuSlot: 0
    };
  }

  listStats(): SessionRuntimeStats[] {
    return Array.from(this.sessions.keys())
      .map((meetingId) => this.getStats(meetingId))
      .filter((item): item is SessionRuntimeStats => item !== null);
  }

  private async runInferenceStep(session: RuntimeSession): Promise<void> {
    const queueDepthMs = session.ring.getSnapshot().depthMs;
    if (queueDepthMs > session.maxQueueMs) {
      // Trim by reading and dropping one hop without inference.
      const skipped = session.ring.readWindow(session.hopSamples, session.hopSamples);
      if (skipped) {
        session.stats.droppedFrames += 1;
      }
      return;
    }

    const window = session.ring.readWindow(session.windowSamples, session.hopSamples);
    if (!window) {
      return;
    }
    const startedAtMs = Date.now();
    const [a2fResult, a2emResult] = await Promise.all([
      session.a2f.execute({ pcm16: window, sampleRateHz: session.sampleRateHz }),
      session.a2em.execute({ pcm16: window, sampleRateHz: session.sampleRateHz })
    ]);
    const latencyMs = Date.now() - startedAtMs;
    const frame: RuntimeFrameEnvelope = {
      meetingId: session.meetingId,
      timestamp: session.clock.nowMs(),
      blendshapes: a2fResult.blendshapes,
      emotions: a2emResult.emotions,
      audioPower: computeRms(window),
      latencyMs
    };
    session.outbox.push(frame);
    if (session.outbox.length > 120) {
      session.outbox.splice(0, session.outbox.length - 120);
      session.stats.droppedFrames += 1;
    }
    session.stats.totalFrames += 1;
    session.stats.latencySamples.push(latencyMs);
    if (session.stats.latencySamples.length > 1000) {
      session.stats.latencySamples.splice(0, session.stats.latencySamples.length - 1000);
    }
    session.stats.lastFrameAtMs = Date.now();
  }

  private flushOutput(session: RuntimeSession): void {
    if (session.outbox.length === 0 || session.subscribers.size === 0) {
      return;
    }
    const frame = session.outbox.shift();
    if (!frame) {
      return;
    }
    for (const subscriber of session.subscribers) {
      if (subscriber.format === "protobuf") {
        subscriber.onFrame(session.protobufEncoder.encode(frame));
        continue;
      }
      subscriber.onFrame(frame);
    }
  }

  private computeFps(session: RuntimeSession): number {
    const elapsedMs = Math.max(1, Date.now() - session.clock.nowMs() + session.clock.nowMs());
    // We use last 5s rate approximation to avoid extra timers.
    const recent = Math.min(session.stats.totalFrames, session.targetFps * 5);
    const baselineMs = Math.min(elapsedMs, 5000);
    return Number(((recent / baselineMs) * 1000).toFixed(2));
  }
}

function computeRms(samples: Int16Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const normalized = samples[i]! / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples.length);
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

