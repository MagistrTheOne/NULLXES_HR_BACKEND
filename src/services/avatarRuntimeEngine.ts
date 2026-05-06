import { env } from "../config/env";
import { logger } from "../logging/logger";
import type { RuntimeEventStore } from "./runtimeEventStore";
import { AudioRingBuffer } from "./audioRingBuffer";
import { ClipBuffer, type AvatarClip } from "./clipBuffer";
import { RunpodWorkerClient } from "./runpodWorkerClient";
import type { OpenAiRealtimeOrchestrator } from "./openaiOrchestrator";
import { StreamAgentPublisher } from "./streamAgentPublisher";
import { withRetries } from "./retry";
import { createStaticI420Frame } from "./staticI420Frame";

function base64FromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export class AvatarRuntimeEngine {
  private readonly orchestrator: OpenAiRealtimeOrchestrator;
  private readonly publisher: StreamAgentPublisher;
  private readonly runpod: RunpodWorkerClient;
  private readonly audioRing: AudioRingBuffer;
  private readonly clipBuffer: ClipBuffer;
  private readonly runtimeEvents?: RuntimeEventStore;

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

  constructor(input: {
    orchestrator: OpenAiRealtimeOrchestrator;
    publisher: StreamAgentPublisher;
    runpod: RunpodWorkerClient;
    runtimeEvents?: RuntimeEventStore;
    fps?: number;
    latencyCompensationMs?: number;
    minBufferSeconds?: number;
    maxBufferSeconds?: number;
  }) {
    this.orchestrator = input.orchestrator;
    this.publisher = input.publisher;
    this.runpod = input.runpod;
    this.runtimeEvents = input.runtimeEvents;
    this.fps = input.fps ?? 25;
    this.latencyCompensationMs = input.latencyCompensationMs ?? 1200;
    this.minBufferSeconds = input.minBufferSeconds ?? 2.0;
    const maxSeconds = input.maxBufferSeconds ?? 6.0;
    this.maxBufferMs = Math.floor(maxSeconds * 1000);
    this.audioRing = new AudioRingBuffer({ maxMs: 15_000 });
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
    this.lastVideoTickAtMs = Date.now();
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

    this.orchestrator.ingestTtsPcm16(this.meetingId, {
      pcm16: input.pcm16,
      sampleRateHz: input.sampleRateHz,
      timestampMs: input.timestampMs
    });

    const now = Date.now();
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

    // Publish audio immediately (fire-and-forget).
    void this.publisher.publishAudioPcm16(input.pcm16, input.timestampMs, input.sampleRateHz).catch(() => undefined);

    // Append into bounded ring for window extraction.
    const pcm16Array = new Int16Array(
      input.pcm16.buffer.slice(input.pcm16.byteOffset, input.pcm16.byteOffset + input.pcm16.byteLength)
    );
    this.audioRing.append({
      startMs: input.timestampMs,
      sampleRateHz: input.sampleRateHz,
      pcm16: pcm16Array
    });

    // Kick generator if buffer is low.
    void this.maybeGenerateClip().catch(() => undefined);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stopController?.abort();
    this.stopController = null;
    if (this.videoTickTimer) clearInterval(this.videoTickTimer);
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.videoTickTimer = null;
    this.telemetryTimer = null;
    void this.publisher.close().catch(() => undefined);
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
    if (!env.AVATAR_VIDEO_ENABLED) return;

    const audioClock = this.orchestrator.getAudioClockMs(this.meetingId) ?? Date.now();
    const targetTime = audioClock - this.latencyCompensationMs;
    const useEcho = env.VIDEO_MODEL === "echomimic" && this.runpod.isConfigured();
    const frame = useEcho ? this.clipBuffer.getFrameAtTime(targetTime) : null;

    if (!frame) {
      this.underflowTicks += 1;
      const useStatic = env.AVATAR_VIDEO_DEGRADED_FALLBACK === "static" || !useEcho;
      if (useStatic) {
        const width = 512;
        const height = 512;
        this.staticFallbackFrame ??= createStaticI420Frame(width, height, 16);
        await this.publisher
          .publishVideoFrameI420(this.staticFallbackFrame.data, width, height, targetTime)
          .catch(() => undefined);
      }
      return;
    }
    await this.publisher.publishVideoFrameI420(frame.i420, frame.width, frame.height, targetTime).catch(() => undefined);
  }

  private async maybeGenerateClip(): Promise<void> {
    if (!this.running || !this.meetingId || !this.sessionId) return;
    if (!env.AVATAR_VIDEO_ENABLED) return;
    if (!this.runpod.isConfigured()) return;
    if (env.VIDEO_MODEL !== "echomimic") return;
    if (this.inFlight >= this.maxInFlight) return;
    if (Date.now() < this.nextGenerationAllowedAtMs) return;

    const nowMs = Date.now();
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
    const pcm16 = this.audioRing.readWindow({
      startMs: windowStart,
      durationMs: windowDurationMs,
      sampleRateHz: audioRate
    });
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
        this.nextGenerationAllowedAtMs = Date.now() + 10_000;
        logger.warn(
          {
            event: "worker_degraded",
            meetingId: this.meetingId,
            sessionId: this.sessionId,
            reason: result.reason,
            workerStatus: result.workerStatus,
            workerLatencyMs: result.workerLatencyMs
          },
          "worker_degraded"
        );
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
            bufferedSeconds: this.clipBuffer.getBufferedSeconds(Date.now())
          }
        }).catch(() => undefined);
        return;
      }

      // Ignore stale responses after interruption.
      if (epoch !== this.clipBuffer.getEpoch() || result.epoch !== epoch) {
        return;
      }

      const clip: AvatarClip = {
        id: `${result.sessionId}-${result.epoch}-${Date.now()}`,
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
          bufferSeconds: this.clipBuffer.getBufferedSeconds(Date.now())
        }
      }).catch(() => undefined);
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  private async emitTelemetry(): Promise<void> {
    if (!this.running || !this.meetingId || !this.sessionId) return;
    const nowMs = Date.now();
    const stats = this.clipBuffer.stats(nowMs);
    const audioClock = this.orchestrator.getAudioClockMs(this.meetingId) ?? nowMs;
    const audioClockDriftMs = nowMs - audioClock;
    const underflowSeconds = this.underflowTicks / this.fps;
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
        audioClockDriftMs
      }
    }).catch(() => undefined);
  }
}

