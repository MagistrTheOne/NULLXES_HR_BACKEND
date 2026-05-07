import { env } from "../config/env";
import { logger } from "../logging/logger";
import { AvatarRuntimeEngine } from "./avatarRuntimeEngine";
import { MeetingControlWsHub } from "./meetingControlWsHub";
import { OpenAiRealtimeOrchestrator } from "./openaiOrchestrator";
import { RunpodWorkerClient } from "./runpodWorkerClient";
import { StreamAgentPublisher } from "./streamAgentPublisher";
import type { RuntimeEventStore } from "./runtimeEventStore";

type RuntimeState = "idle" | "starting" | "active" | "degraded" | "paused" | "stopped";

type RuntimeSession = {
  meetingId: string;
  numericMeetingId?: number;
  sessionId: string;
  state: RuntimeState;
  createdAtMs: number;
  updatedAtMs: number;
  epoch: number;
  paused: boolean;
  subtitlesSuppressed: boolean;
  seenTranscriptKeys: Set<string>;
  openai: OpenAiRealtimeOrchestrator;
  runpod: RunpodWorkerClient;
  engine?: AvatarRuntimeEngine;
};

type RealtimeEventInput = {
  meetingId?: string;
  sessionId: string;
  type: string;
  rawPayload?: Record<string, unknown>;
  normalizedPayload?: Record<string, unknown>;
  timestampMs?: number;
};

export class AvatarRuntimeSessionManager {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly numericToInternal = new Map<number, string>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: {
      runtimeEvents?: RuntimeEventStore;
      controlWsHub?: MeetingControlWsHub;
      inactiveTtlMs?: number;
    }
  ) {}

  async startForMeeting(input: { meetingId: string; numericMeetingId?: number; sessionId?: string }): Promise<void> {
    const existing = this.sessions.get(input.meetingId);
    if (existing && existing.state !== "stopped") {
      return;
    }

    const sessionId = input.sessionId ?? input.meetingId;
    const openai = new OpenAiRealtimeOrchestrator({ runtimeEvents: this.options.runtimeEvents });
    openai.start(input.meetingId, sessionId);
    const runpod = new RunpodWorkerClient();
    const session: RuntimeSession = {
      meetingId: input.meetingId,
      numericMeetingId: input.numericMeetingId,
      sessionId,
      state: "starting",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      epoch: 0,
      paused: false,
      subtitlesSuppressed: false,
      seenTranscriptKeys: new Set(),
      openai,
      runpod
    };
    this.sessions.set(input.meetingId, session);
    if (typeof input.numericMeetingId === "number") {
      this.numericToInternal.set(input.numericMeetingId, input.meetingId);
    }

    const readiness = await this.checkProductionReadiness(runpod);
    if (!readiness.ok) {
      session.state = "degraded";
      this.touch(session);
      await this.options.runtimeEvents?.append({
        type: "avatar.runtime.degraded",
        meetingId: input.meetingId,
        sessionId,
        actor: "gateway",
        payload: { reason: readiness.reason, detail: readiness.detail }
      }).catch(() => undefined);
      logger.warn({ meetingId: input.meetingId, reason: readiness.reason, detail: readiness.detail }, "avatar runtime degraded before start");
      return;
    }

    const engine = new AvatarRuntimeEngine({
      orchestrator: openai,
      publisher: new StreamAgentPublisher(),
      runpod,
      runtimeEvents: this.options.runtimeEvents
    });
    session.engine = engine;
    try {
      await engine.start({ meetingId: input.meetingId, sessionId, openAiAudioRateHz: 24_000 });
      session.state = "active";
      this.touch(session);
      await this.options.runtimeEvents?.append({
        type: "avatar.runtime.started",
        meetingId: input.meetingId,
        sessionId,
        actor: "gateway",
        payload: { numericMeetingId: input.numericMeetingId, transport: "stream", renderer: "echomimic" }
      }).catch(() => undefined);
    } catch (error) {
      session.state = "degraded";
      session.engine = undefined;
      this.touch(session);
      await this.options.runtimeEvents?.append({
        type: "avatar.runtime.degraded",
        meetingId: input.meetingId,
        sessionId,
        actor: "gateway",
        payload: { reason: "engine_start_failed", error: error instanceof Error ? error.message : String(error) }
      }).catch(() => undefined);
      logger.warn({ meetingId: input.meetingId, err: error }, "avatar runtime engine start failed");
    }
  }

  handleRealtimeEvent(input: RealtimeEventInput): void {
    const session = this.resolveSession(input.meetingId);
    if (!session || session.state === "stopped") {
      return;
    }
    this.touch(session);
    const type = input.type;

    if (type === "input_audio_buffer.speech_started" || type === "speech.started") {
      this.publishActivity(session, "candidate", "speaking");
      return;
    }
    if (type === "input_audio_buffer.speech_stopped" || type === "speech.stopped") {
      this.publishActivity(session, "candidate", "listening");
      return;
    }
    if (type === "response.create" || type === "response.created") {
      this.publishActivity(session, "ai_agent", session.paused ? "paused" : "thinking");
      return;
    }
    if (type === "response.done") {
      this.publishActivity(session, "ai_agent", session.paused ? "paused" : "listening");
      return;
    }
    if (type.includes("interrupt") || type.includes("cancel") || type === "conversation.item.truncated") {
      this.interrupt(session.meetingId, "openai_interrupt");
      return;
    }

    const transcriptDelta = this.extractTranscriptDelta(input);
    if (transcriptDelta) {
      this.publishActivity(session, "ai_agent", session.paused ? "paused" : "speaking");
      this.publishSubtitle(session, input, transcriptDelta);
    }

    const audioDelta = this.extractAudioDelta(input);
    if (audioDelta) {
      this.publishActivity(session, "ai_agent", session.paused ? "paused" : "speaking");
      this.ingestOpenAiAudioDelta(session.meetingId, {
        pcm16Base64: audioDelta,
        sampleRateHz: 24_000,
        timestampMs: input.timestampMs ?? Date.now()
      });
    }
  }

  ingestOpenAiAudioDelta(
    meetingId: string,
    input: { pcm16Base64: string; sampleRateHz: number; timestampMs: number }
  ): void {
    const session = this.resolveSession(meetingId);
    if (!session || session.paused || session.state === "stopped") {
      return;
    }
    const pcm16 = Buffer.from(input.pcm16Base64, "base64");
    if (pcm16.length === 0) {
      return;
    }
    session.openai.ingestTtsPcm16(session.meetingId, {
      pcm16,
      sampleRateHz: input.sampleRateHz,
      timestampMs: input.timestampMs
    });
    session.engine?.ingestOpenAiTtsPcm16({
      pcm16,
      sampleRateHz: input.sampleRateHz,
      timestampMs: input.timestampMs
    });
    this.touch(session);
  }

  pause(meetingId: string, reason = "pause_requested"): void {
    const session = this.resolveSession(meetingId);
    if (!session || session.state === "stopped") return;
    session.paused = true;
    session.subtitlesSuppressed = true;
    session.epoch += 1;
    session.state = "paused";
    session.seenTranscriptKeys.clear();
    session.engine?.pause(reason);
    this.publishActivity(session, "ai_agent", "paused");
    this.touch(session);
  }

  resume(meetingId: string): void {
    const session = this.resolveSession(meetingId);
    if (!session || session.state === "stopped") return;
    session.paused = false;
    session.subtitlesSuppressed = false;
    session.epoch += 1;
    session.state = session.engine ? "active" : "degraded";
    session.seenTranscriptKeys.clear();
    session.engine?.resume();
    this.publishActivity(session, "ai_agent", "listening");
    this.touch(session);
  }

  interrupt(meetingId: string, reason: string): void {
    const session = this.resolveSession(meetingId);
    if (!session || session.state === "stopped") return;
    session.epoch += 1;
    session.seenTranscriptKeys.clear();
    session.openai.interrupt(session.meetingId, reason);
    session.engine?.interrupt(reason);
    this.publishActivity(session, "ai_agent", session.paused ? "paused" : "listening");
    void this.options.runtimeEvents?.append({
      type: "avatar.runtime.interrupted",
      meetingId: session.meetingId,
      sessionId: session.sessionId,
      actor: "gateway",
      payload: { reason, epoch: session.epoch }
    }).catch(() => undefined);
    this.touch(session);
  }

  stop(meetingId: string, reason = "meeting_stop"): void {
    const session = this.resolveSession(meetingId);
    if (!session) return;
    session.state = "stopped";
    session.paused = true;
    session.subtitlesSuppressed = true;
    session.epoch += 1;
    session.seenTranscriptKeys.clear();
    session.engine?.stop();
    session.openai.close(session.meetingId);
    if (typeof session.numericMeetingId === "number") {
      this.options.controlWsHub?.publishCurrentQuestion(session.numericMeetingId, null);
      this.options.controlWsHub?.publishActivityMode(session.numericMeetingId, "ai_agent", "paused");
      this.numericToInternal.delete(session.numericMeetingId);
    }
    void this.options.runtimeEvents?.append({
      type: "avatar.runtime.stopped",
      meetingId: session.meetingId,
      sessionId: session.sessionId,
      actor: "gateway",
      payload: { reason }
    }).catch(() => undefined);
    this.sessions.delete(session.meetingId);
  }

  publishCurrentQuestion(meetingId: string, questionIndex: number | null): void {
    const session = this.resolveSession(meetingId);
    if (session?.numericMeetingId) {
      this.options.controlWsHub?.publishCurrentQuestion(session.numericMeetingId, questionIndex);
    }
  }

  startSweeper(intervalMs = 30_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.sweep(), intervalMs);
  }

  stopSweeper(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private sweep(): void {
    const ttl = this.options.inactiveTtlMs ?? 30 * 60_000;
    const cutoff = Date.now() - ttl;
    for (const session of this.sessions.values()) {
      if (session.updatedAtMs < cutoff) {
        this.stop(session.meetingId, "inactive_runtime_ttl");
      }
    }
  }

  private async checkProductionReadiness(runpod: RunpodWorkerClient): Promise<{ ok: boolean; reason?: string; detail?: unknown }> {
    if (!env.AVATAR_VIDEO_ENABLED || env.VIDEO_MODEL !== "echomimic") {
      return { ok: false, reason: "echomimic_disabled" };
    }
    if (!env.STREAM_API_KEY || !env.STREAM_API_SECRET) {
      return { ok: false, reason: "stream_unconfigured" };
    }
    if (!runpod.isConfigured()) {
      return { ok: false, reason: "runpod_unconfigured" };
    }
    const health = await runpod.checkHealth().catch((error: unknown) => ({
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    }));
    return health.ok ? { ok: true } : { ok: false, reason: "runpod_unhealthy", detail: health.detail };
  }

  private resolveSession(meetingId: string | undefined): RuntimeSession | undefined {
    if (!meetingId) return undefined;
    const exact = this.sessions.get(meetingId);
    if (exact) return exact;
    const numeric = Number(meetingId);
    if (Number.isSafeInteger(numeric)) {
      const internal = this.numericToInternal.get(numeric);
      return internal ? this.sessions.get(internal) : undefined;
    }
    return undefined;
  }

  private publishActivity(
    session: RuntimeSession,
    role: "candidate" | "ai_agent",
    value: "listening" | "speaking" | "thinking" | "paused"
  ): void {
    if (typeof session.numericMeetingId !== "number") return;
    if (role === "candidate") {
      if (value !== "listening" && value !== "speaking") return;
      this.options.controlWsHub?.publishActivityMode(session.numericMeetingId, "candidate", value);
      return;
    }
    this.options.controlWsHub?.publishActivityMode(session.numericMeetingId, "ai_agent", value);
  }

  private publishSubtitle(session: RuntimeSession, event: RealtimeEventInput, text: string): void {
    if (session.paused || session.subtitlesSuppressed || typeof session.numericMeetingId !== "number") return;
    const itemId = String(event.normalizedPayload?.itemId ?? event.rawPayload?.item_id ?? event.rawPayload?.itemId ?? "item");
    const outputIndex = String(event.normalizedPayload?.outputIndex ?? event.rawPayload?.output_index ?? "");
    const contentIndex = String(event.normalizedPayload?.contentIndex ?? event.rawPayload?.content_index ?? "");
    const key = `${event.type}:${itemId}:${outputIndex}:${contentIndex}:${text}`;
    if (session.seenTranscriptKeys.has(key)) {
      return;
    }
    session.seenTranscriptKeys.add(key);
    if (session.seenTranscriptKeys.size > 500) {
      session.seenTranscriptKeys.clear();
    }
    this.options.controlWsHub?.publishSubtitlesDelta(session.numericMeetingId, text);
  }

  private extractTranscriptDelta(input: RealtimeEventInput): string | null {
    if (!input.type.includes("transcript") || !input.type.endsWith(".delta")) {
      return null;
    }
    const payloads = [input.normalizedPayload, input.rawPayload].filter(Boolean) as Record<string, unknown>[];
    for (const payload of payloads) {
      const delta = payload.delta ?? payload.text;
      if (typeof delta === "string" && delta.trim()) {
        return delta;
      }
    }
    return null;
  }

  private extractAudioDelta(input: RealtimeEventInput): string | null {
    if (
      input.type !== "response.audio.delta" &&
      input.type !== "response.output_audio.delta" &&
      input.type !== "output_audio.delta"
    ) {
      return null;
    }
    const payloads = [input.normalizedPayload, input.rawPayload].filter(Boolean) as Record<string, unknown>[];
    for (const payload of payloads) {
      const delta = payload.delta ?? payload.audio ?? payload.pcm16;
      if (typeof delta === "string" && delta.trim()) {
        return delta;
      }
    }
    return null;
  }

  private touch(session: RuntimeSession): void {
    session.updatedAtMs = Date.now();
  }
}
