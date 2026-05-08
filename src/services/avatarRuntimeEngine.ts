import { env } from "../config/env";
import { logger } from "../logging/logger";
import type { RuntimeEventStore } from "./runtimeEventStore";
import { MicRingBuffer, TtsRingBuffer } from "./audioRingBuffer";
import { ClipBuffer, type AvatarClip } from "./clipBuffer";
import { RunpodWorkerClient } from "./runpodWorkerClient";
import type { OpenAiRealtimeOrchestrator } from "./openaiOrchestrator";
import type { AgentMediaPublisher } from "./streamAgentPublisher";
import { withRetries } from "./retry";
import { createStaticI420Frame } from "./staticI420Frame";
import type { MasterClock } from "./masterClock";

function base64FromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export class AvatarRuntimeEngine {
  private readonly orchestrator: OpenAiRealtimeOrchestrator;
  private readonly publisher: AgentMediaPublisher;
  private readonly runpod: RunpodWorkerClient;
  private readonly ttsRing: TtsRingBuffer;
  private readonly micRing: MicRingBuffer;
  private readonly clipBuffer: ClipBuffer;
  private readonly runtimeEvents?: RuntimeEventStore;
  private readonly clock: MasterClock;

  private meetingId: string | null = null;
  private sessionId: string | null = null;

  private running = false;
  private stopController: AbortController | null = null;

  private videoTickTimer: NodeJS.Timeout | null = null;
  private telemetryTimer: NodeJS.Timeout | null = null;

  private readonly fps: number;
  private readonly latencyCompensationMs: number;
  private readonly minBufferSeconds: number;
  private readonly maxBufferMs: number;

  private inFlight = 0;
  private readonly maxInFlight: number;
  private nextGenerationAllowedAtMs = 0;

  private underflowTicks = 0;
  private lastVideoTickAtMs = 0;
  private staticFallbackFrame: { width: number; height: number; data: Buffer } | null = null;
  private lastAvatarAudioPcmLogAtMs = 0;
  private paused = false;
  private stoppedAtMs: number | null = null;
  private staleClipDrops = 0;
  private publishedFrames = 0;
  private lastPublishFpsSampleAtMs = Date.now();
  private lastPublishedFramesSample = 0;
  private audioQueueDropCount = 0;
  private underrunCount = 0;
  private chunkViolationCount = 0;
  private lastChunkSizeMs = 0;

  constructor(input: {
    orchestrator: OpenAiRealtimeOrchestrator;
    publisher: AgentMediaPublisher;
    runpod: RunpodWorkerClient;
    clock: MasterClock;
    runtimeEvents?: RuntimeEventStore;
    fps?: number;
    latencyCompensationMs?: number;
    minBufferSeconds?: number;
    maxBufferSeconds?: number;
  }) {
    this.orchestrator = input.orchestrator;
    this.publisher = input.publisher;
    this.runpod = input.runpod;
    this.clock = input.clock;
    this.runtimeEvents = input.runtimeEvents;
    this.fps = input.fps ?? 25;
    this.latencyCompensationMs = input.latencyCompensationMs ?? 1200;
    this.minBufferSeconds = input.minBufferSeconds ?? 2.0;
    const maxSeconds = input.maxBufferSeconds ?? 6.0;
    this.maxBufferMs = Math.floor(maxSeconds * 1000);
    this.ttsRing = new TtsRingBuffer({ maxMs: 15_000 });
    this.micRing = new MicRingBuffer({ maxMs: 15_000 });
    this.clipBuffer = new ClipBuffer({ maxBufferMs: this.maxBufferMs });
    this.maxInFlight = env.RUNPOD_WORKER_MAX_INFLIGHT;
  }

  async start(input: { meetingId: string; sessionId: string; openAiAudioRateHz?: number }): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.meetingId = input.meetingId;
    this.sessionId = input.sessionId;
    this.stopController = new AbortController();

    await this.publisher.connect({
      meetingId: input.meetingId,
      sessionId: input.sessionId,
      audioInRateHz: input.openAiAudioRateHz
    });

    // Subscribe to OpenAI orchestrator events.
    const unsubscribe = this.orchestrator.onEvent((meetingId, sessionId, event) => {
      if (!this.running) return;
      if (this.meetingId !== meetingId || this.sessionId !== sessionId) return;
      if (event.type === "interrupt") {
        this.onInterruption(event.payload.reason);
      }
      // tts.pcm16 is ingested out-of-band by whoever calls orchestrator.ingestTtsPcm16().
    });

    // Start video tick loop.
    this.lastVideoTickAtMs = this.clock.nowMs();
    this.videoTickTimer = setInterval(() => {
      void this.videoTick().catch(() => undefined);
    }, Math.floor(1000 / this.fps));

    // Telemetry loop.
    this.telemetryTimer = setInterval(() => {
      void this.emitTelemetry().catch(() => undefined);
    }, 1000);

    // Ensure cleanup removes subscription.
    this.stopController.signal.addEventListener(
      "abort",
      () => {
        unsubscribe();
      },
      { once: true }
    );
  }

  /**
   * Called by the OpenAI transport whenever a PCM16 TTS chunk arrives.
   * This must remain realtime-safe: publish audio immediately; never wait for video.
   */
  ingestOpenAiTtsPcm16(input: { pcm16: Buffer; sampleRateHz: number; timestampMs: number }): void {
    if (!this.running || !this.meetingId || !this.sessionId) return;
    if (this.paused || this.stoppedAtMs !== null) return;

    const now = this.clock.nowMs();
    if (now - this.lastAvatarAudioPcmLogAtMs >= 500) {
      this.lastAvatarAudioPcmLogAtMs = now;
      logger.info(
        {
          event: "avatar_audio_pcm_received",
          meetingId: this.meetingId,
          sessionId: this.sessionId,
          bytes: input.pcm16.length,
          sampleRateHz: input.sampleRateHz,
          timestampMs: input.timestampMs
        },
        "avatar_audio_pcm_received"
      );
    }

    const chunks = this.normalizeChunkPcm16(input.pcm16, input.sampleRateHz, input.timestampMs);
    for (const chunk of chunks) {
      void this.publisher.publishAudioPcm16(chunk.pcm16, chunk.startMs, input.sampleRateHz).catch(() => undefined);
      this.ttsRing.append({
        startMs: chunk.startMs,
        sampleRateHz: input.sampleRateHz,
        pcm16: chunk.samples
      });
    }
    this.applyAudioQueueBudget();

    // Kick generator if buffer is low.
    void this.maybeGenerateClip().catch(() => undefined);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stoppedAtMs = this.clock.nowMs();
    this.ttsRing.clear();
    this.micRing.clear();
    this.clipBuffer.invalidateEpoch("runtime_stop");
    this.stopController?.abort();
    this.stopController = null;
    if (this.videoTickTimer) clearInterval(this.videoTickTimer);
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.videoTickTimer = null;
    this.telemetryTimer = null;
    void this.publisher.close().catch(() => undefined);
  }

  pause(reason = "runtime_pause"): void {
    if (!this.running) return;
    this.paused = true;
    this.ttsRing.clear();
    this.micRing.clear();
    this.onInterruption(reason);
  }

  resume(): void {
    if (!this.running) return;
    this.paused = false;
    this.ttsRing.clear();
    this.micRing.clear();
    this.onInterruption("runtime_resume_new_epoch");
  }

  interrupt(reason: string): void {
    if (!this.running) return;
    this.ttsRing.clear();
    this.micRing.clear();
    this.onInterruption(reason);
  }

  private onInterruption(reason: string): void {
    const nextEpoch = this.clipBuffer.invalidateEpoch(reason);
    void this.runtimeEvents?.append({
      type: "avatar.degraded",
      meetingId: this.meetingId ?? undefined,
      sessionId: this.sessionId ?? undefined,
      actor: "gateway",
      payload: { reason, generationEpoch: nextEpoch }
    }).catch(() => undefined);
  }

  private async videoTick(): Promise<void> {
    if (!this.running || !this.meetingId) return;
    if (this.paused || this.stoppedAtMs !== null) return;
    if (!env.AVATAR_VIDEO_ENABLED || env.VIDEO_MODEL !== "echomimic") return;
    const audioClock = this.orchestrator.getAudioClockMs(this.meetingId) ?? this.clock.nowMs();
    const targetTime = audioClock - this.latencyCompensationMs;
    const frame = this.clipBuffer.getFrameAtTime(targetTime);
    if (!frame) {
      this.underflowTicks += 1;
      this.underrunCount += 1;
      if (env.AVATAR_VIDEO_DEGRADED_FALLBACK === "static") {
        const width = 512;
        const height = 512;
        this.staticFallbackFrame ??= createStaticI420Frame(width, height, 16);
        await this.publisher
          .publishVideoFrameI420(this.idleFallbackFrame(this.staticFallbackFrame.data, width, height), width, height, targetTime)
          .catch(() => undefined);
        this.publishedFrames += 1;
      }
      return;
    }
    // Publish I420 frame.
    await this.publisher.publishVideoFrameI420(frame.i420, frame.width, frame.height, targetTime).catch(() => undefined);
    this.publishedFrames += 1;
  }

  private async maybeGenerateClip(): Promise<void> {
    if (!this.running || !this.meetingId || !this.sessionId) return;
    if (this.paused || this.stoppedAtMs !== null) return;
    if (!env.AVATAR_VIDEO_ENABLED) return;
    if (!this.runpod.isConfigured()) return;
    if (env.VIDEO_MODEL !== "echomimic") return;
    if (this.inFlight >= this.maxInFlight) return;
    if (this.clock.nowMs() < this.nextGenerationAllowedAtMs) return;

    const nowMs = this.clock.nowMs();
    const buffered = this.clipBuffer.getBufferedSeconds(nowMs);
    if (buffered >= this.minBufferSeconds) return;

    const epoch = this.clipBuffer.getEpoch();
    logger.info(
      {
        event: "echomimic_clip_request_started",
        meetingId: this.meetingId,
        sessionId: this.sessionId,
        epoch,
        bufferedSeconds: buffered,
        queueDepth: this.inFlight
      },
      "echomimic_clip_request_started"
    );
    const audioRate = (this.orchestrator.getAudioInRateHz(this.meetingId) ?? 24_000) as 16000 | 24000 | 48000;
    const windowDurationMs = 1000; // 1s clip window
    const windowStart = nowMs - this.latencyCompensationMs;
    let pcm16 = this.ttsRing.readWindow({
      startMs: windowStart,
      durationMs: windowDurationMs,
      sampleRateHz: audioRate
    });
    if (pcm16.length === 0 || this.isSilence(pcm16)) {
      this.underrunCount += 1;
      pcm16 = this.zeroPcm16(windowDurationMs, audioRate);
    }
    const pcm16Bytes = new Uint8Array(pcm16.buffer);
    const b64 = base64FromBytes(pcm16Bytes);

    this.inFlight += 1;
    void this.runtimeEvents?.append({
      type: "avatar.buffering",
      meetingId: this.meetingId,
      sessionId: this.sessionId,
      actor: "gateway",
      payload: { bufferedSeconds: buffered, queueDepth: this.inFlight, generationEpoch: epoch }
    }).catch(() => undefined);

    try {
      const result = await withRetries(
        () =>
          this.runpod.generateClipBestEffort({
            meetingId: this.meetingId as string,
            sessionId: this.sessionId as string,
            epoch,
            audioPcm16Base64: b64,
            audioSampleRate: audioRate,
            fps: 25,
            width: 512,
            height: 512,
            numFrames: 25,
            numInferenceSteps: 3,
            seed: 44,
            prompt: "A realistic HR avatar is speaking naturally to camera, stable face, realistic lipsync, professional upper body framing, centered face, cinematic lighting, sharp eyes.",
            negativePrompt:
              "blurry, distorted face, unstable eyes, warped mouth, bad teeth, face melting, duplicate face, watermark, text",
            returnFrames: env.RUNPOD_WORKER_RETURN_FRAMES
          }),
        { attempts: 1, backoffMs: [0] }
      );

      if (!result.ok) {
        this.nextGenerationAllowedAtMs = this.clock.nowMs() + 10_000;
        void this.runtimeEvents?.append({
          type: "avatar.degraded",
          meetingId: this.meetingId,
          sessionId: this.sessionId,
          actor: "gateway",
          payload: {
            degraded: true,
            reason: result.reason,
            generationEpoch: epoch,
            workerStatus: result.workerStatus,
            workerLatencyMs: result.workerLatencyMs,
            queueDepth: this.inFlight,
            bufferedSeconds: this.clipBuffer.getBufferedSeconds(this.clock.nowMs())
          }
        }).catch(() => undefined);
        return;
      }

      // Ignore stale responses after interruption.
      if (epoch !== this.clipBuffer.getEpoch() || result.epoch !== epoch) {
        this.staleClipDrops += 1;
        void this.runtimeEvents?.append({
          type: "avatar.degraded",
          meetingId: this.meetingId,
          sessionId: this.sessionId,
          actor: "gateway",
          payload: { reason: "stale_clip_dropped", generationEpoch: epoch, staleClipDrops: this.staleClipDrops }
        }).catch(() => undefined);
        return;
      }

      const clip: AvatarClip = {
        id: `${result.sessionId}-${result.epoch}-${this.clock.nowMs()}`,
        epoch,
        fps: result.fps,
        width: result.width,
        height: result.height,
        frames: result.frames.map((f) => ({ ptsMs: f.ptsMs, b64: f.i420Base64, format: "i420" })),
        audioStartMs: windowStart,
        durationMs: windowDurationMs
      };
      this.clipBuffer.enqueueClip(clip);

      void this.runtimeEvents?.append({
        type: "avatar.telemetry",
        meetingId: this.meetingId,
        sessionId: this.sessionId,
        actor: "gateway",
        payload: {
          model: "echomimic",
          generationEpoch: epoch,
          clipLatencyMs: result.telemetry.clipLatencyMs,
          queueDepth: result.telemetry.queueDepth ?? this.inFlight,
          gpuMemoryMb: result.telemetry.gpuMemoryMb,
          bufferSeconds: this.clipBuffer.getBufferedSeconds(this.clock.nowMs())
        }
      }).catch(() => undefined);
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  private async emitTelemetry(): Promise<void> {
    if (!this.running || !this.meetingId || !this.sessionId) return;
    const nowMs = this.clock.nowMs();
    const stats = this.clipBuffer.stats(nowMs);
    const audioClock = this.orchestrator.getAudioClockMs(this.meetingId) ?? nowMs;
    const audioClockDriftMs = nowMs - audioClock;
    const underflowSeconds = this.underflowTicks / this.fps;
    const elapsedMs = Math.max(1, nowMs - this.lastPublishFpsSampleAtMs);
    const publishFps = ((this.publishedFrames - this.lastPublishedFramesSample) * 1000) / elapsedMs;
    this.lastPublishFpsSampleAtMs = nowMs;
    this.lastPublishedFramesSample = this.publishedFrames;
    void this.runtimeEvents?.append({
      type: "avatar.telemetry",
      meetingId: this.meetingId,
      sessionId: this.sessionId,
      actor: "gateway",
      payload: {
        generationEpoch: stats.epoch,
        bufferedSeconds: stats.bufferedSeconds,
        droppedFrames: stats.droppedFrames,
        underflowSeconds,
        queueDepth: this.inFlight,
        audioClockDriftMs,
        paused: this.paused,
        staleClipDrops: this.staleClipDrops,
        publishFps,
        micRingSizeMs: this.micRing.getBufferedMs(),
        ttsRingSizeMs: this.ttsRing.getBufferedMs(),
        underrunCount: this.underrunCount,
        audioQueueDropCount: this.audioQueueDropCount,
        chunkViolationCount: this.chunkViolationCount,
        chunkSizeMs: this.lastChunkSizeMs
      }
    }).catch(() => undefined);
  }

  private idleFallbackFrame(frame: Buffer, width: number, height: number): Buffer {
    const out = Buffer.from(frame);
    const ySize = width * height;
    const pulse = Math.round(Math.sin(Date.now() / 450) * 4);
    for (let i = 0; i < ySize; i += 4) {
      out[i] = Math.max(0, Math.min(255, out[i] + pulse));
    }
    return out;
  }

  ingestMicPcm16(input: { pcm16: Buffer; sampleRateHz: number; timestampMs: number }): void {
    if (!this.running || this.paused || this.stoppedAtMs !== null) return;
    const chunks = this.normalizeChunkPcm16(input.pcm16, input.sampleRateHz, input.timestampMs);
    for (const chunk of chunks) {
      this.micRing.append({
        startMs: chunk.startMs,
        sampleRateHz: input.sampleRateHz,
        pcm16: chunk.samples
      });
    }
    this.applyAudioQueueBudget();
  }

  getStats(): Record<string, number | boolean> {
    return {
      running: this.running,
      paused: this.paused,
      inFlight: this.inFlight,
      micRingSizeMs: this.micRing.getBufferedMs(),
      ttsRingSizeMs: this.ttsRing.getBufferedMs(),
      underrunCount: this.underrunCount,
      audioQueueDropCount: this.audioQueueDropCount,
      chunkViolationCount: this.chunkViolationCount,
      staleClipDrops: this.staleClipDrops
    };
  }

  private normalizeChunkPcm16(
    pcm16: Buffer,
    sampleRateHz: number,
    timestampMs: number
  ): Array<{ pcm16: Buffer; samples: Int16Array; startMs: number }> {
    const bytesPerMs = (sampleRateHz * 2) / 1000;
    const targetMs = env.AVATAR_AUDIO_CHUNK_TARGET_MS;
    const maxMs = env.AVATAR_AUDIO_CHUNK_MAX_MS;
    const chunkBytes = Math.max(2, Math.floor(bytesPerMs * targetMs));
    const maxChunkBytes = Math.max(chunkBytes, Math.floor(bytesPerMs * maxMs));
    if (pcm16.length <= maxChunkBytes) {
      this.lastChunkSizeMs = Math.floor((pcm16.length / bytesPerMs) * 100) / 100;
      return [
        {
          pcm16,
          samples: new Int16Array(pcm16.buffer.slice(pcm16.byteOffset, pcm16.byteOffset + pcm16.byteLength)),
          startMs: timestampMs
        }
      ];
    }
    this.chunkViolationCount += 1;
    const out: Array<{ pcm16: Buffer; samples: Int16Array; startMs: number }> = [];
    for (let offset = 0, index = 0; offset < pcm16.length; offset += chunkBytes, index += 1) {
      const end = Math.min(pcm16.length, offset + chunkBytes);
      const sub = pcm16.subarray(offset, end);
      const startMs = timestampMs + index * targetMs;
      this.lastChunkSizeMs = Math.floor((sub.length / bytesPerMs) * 100) / 100;
      out.push({
        pcm16: sub,
        samples: new Int16Array(sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength)),
        startMs
      });
    }
    return out;
  }

  private applyAudioQueueBudget(): void {
    const budget = env.AVATAR_AUDIO_QUEUE_BUDGET_MS;
    const ttsOver = this.ttsRing.getBufferedMs() - budget;
    if (ttsOver > 0) {
      const dropped = this.ttsRing.dropOldestMs(ttsOver);
      if (dropped > 0) this.audioQueueDropCount += 1;
    }
    const micOver = this.micRing.getBufferedMs() - budget;
    if (micOver > 0) {
      const dropped = this.micRing.dropOldestMs(micOver);
      if (dropped > 0) this.audioQueueDropCount += 1;
    }
  }

  private isSilence(samples: Int16Array): boolean {
    for (let i = 0; i < samples.length; i += 1) {
      if (samples[i] !== 0) return false;
    }
    return true;
  }

  private zeroPcm16(durationMs: number, sampleRateHz: number): Int16Array {
    const sampleCount = Math.max(0, Math.floor((durationMs * sampleRateHz) / 1000));
    return new Int16Array(sampleCount);
  }
}

