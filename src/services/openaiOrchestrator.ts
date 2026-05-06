import { env } from "../config/env";
import { logger } from "../logging/logger";
import type { RuntimeEventStore } from "./runtimeEventStore";

export type OrchestratorSessionState = "starting" | "active" | "failed" | "closed";

export type OpenAiOrchestratorEvent =
  | { type: "tts.pcm16"; payload: { bytes: number; timestampMs: number } }
  | { type: "interrupt"; payload: { reason: string; timestampMs: number } }
  | { type: "boundary"; payload: { name: string; timestampMs: number } };

interface SessionRecord {
  meetingId: string;
  sessionId: string;
  state: OrchestratorSessionState;
  createdAtMs: number;
  lastMicAtMs: number;
  audioClockMs: number;
  audioInRateHz: number;
}

/**
 * OpenAI Realtime termination (gateway authoritative session).
 *
 * NOTE: This is the control-plane skeleton. It records events and provides a
 * single integration point for audio clock / interruptions / boundaries.
 * The actual OpenAI transport (WS/WebRTC) is implemented behind this facade.
 *
 * Audio bridge reality check: assistant TTS in **browser WebRTC** mode may never
 * surface as JSON `response.*audio*.delta` on `POST /realtime/session/:id/events`
 * unless the client forwards those server events. If `openai_event_received` shows
 * no audio deltas, gateway PCM → EchoMimic will not run until a **browser-side**
 * capture bridge exists (see `AVATAR_BROWSER_AUDIO_BRIDGE_ENABLED` in env; not implemented).
 */
export class OpenAiRealtimeOrchestrator {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly runtimeEvents?: RuntimeEventStore;
  private readonly listeners = new Set<(meetingId: string, sessionId: string, event: OpenAiOrchestratorEvent) => void>();

  constructor(options: { runtimeEvents?: RuntimeEventStore }) {
    this.runtimeEvents = options.runtimeEvents;
  }

  start(meetingId: string, sessionId: string): void {
    const now = Date.now();
    this.sessions.set(meetingId, {
      meetingId,
      sessionId,
      state: "starting",
      createdAtMs: now,
      lastMicAtMs: 0,
      audioClockMs: now,
      audioInRateHz: 24_000
    });
    void this.runtimeEvents?.append({
      type: "openai.orchestrator.started",
      meetingId,
      sessionId,
      actor: "gateway",
      payload: { model: env.OPENAI_REALTIME_MODEL }
    }).catch(() => undefined);
    logger.info({ meetingId, sessionId }, "openai orchestrator started (skeleton)");
  }

  appendMicPcm16(meetingId: string, bytes: number, timestampMs: number): void {
    const record = this.sessions.get(meetingId);
    if (!record) return;
    record.lastMicAtMs = timestampMs;
    if (record.state === "starting") {
      record.state = "active";
    }
    void this.runtimeEvents?.append({
      type: "openai.mic.append",
      meetingId,
      sessionId: record.sessionId,
      actor: "frontend",
      payload: { bytes, timestampMs }
    }).catch(() => undefined);
  }

  onEvent(listener: (meetingId: string, sessionId: string, event: OpenAiOrchestratorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Authoritative TTS audio chunk from OpenAI (PCM16). This MUST NOT block.
   * `timestampMs` should correspond to the audio master clock.
   */
  ingestTtsPcm16(meetingId: string, input: { pcm16: Buffer; sampleRateHz: number; timestampMs: number }): void {
    const record = this.sessions.get(meetingId);
    if (!record) return;
    record.audioInRateHz = input.sampleRateHz;
    const durationMs = (input.pcm16.length / 2 / input.sampleRateHz) * 1000;
    record.audioClockMs = Math.max(record.audioClockMs, input.timestampMs + durationMs);
    const event: OpenAiOrchestratorEvent = {
      type: "tts.pcm16",
      payload: { bytes: input.pcm16.length, timestampMs: input.timestampMs }
    };
    for (const l of this.listeners) {
      try {
        l(meetingId, record.sessionId, event);
      } catch {
        /* noop */
      }
    }
  }

  interrupt(meetingId: string, reason: string): void {
    const record = this.sessions.get(meetingId);
    if (!record) return;
    const event: OpenAiOrchestratorEvent = {
      type: "interrupt",
      payload: { reason, timestampMs: Date.now() }
    };
    for (const l of this.listeners) {
      try {
        l(meetingId, record.sessionId, event);
      } catch {
        /* noop */
      }
    }
  }

  getAudioClockMs(meetingId: string): number | null {
    const record = this.sessions.get(meetingId);
    return record ? record.audioClockMs : null;
  }

  getAudioInRateHz(meetingId: string): number | null {
    const record = this.sessions.get(meetingId);
    return record ? record.audioInRateHz : null;
  }

  close(meetingId: string): void {
    const record = this.sessions.get(meetingId);
    if (!record) return;
    record.state = "closed";
    this.sessions.delete(meetingId);
    void this.runtimeEvents?.append({
      type: "openai.orchestrator.closed",
      meetingId,
      sessionId: record.sessionId,
      actor: "gateway",
      payload: {}
    }).catch(() => undefined);
  }
}

