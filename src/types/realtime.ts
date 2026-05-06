export type SessionStatus = "starting" | "active" | "closing" | "closed" | "error";

export interface RealtimeAudioFormat {
  type: "audio/pcm";
  rate: number;
}

export interface RealtimeAudioConfig {
  input: {
    format: RealtimeAudioFormat;
  };
  output: {
    format: RealtimeAudioFormat;
    voice: string;
  };
}

export interface SessionConfig {
  type: "realtime";
  model: string;
  /** GA Realtime: session-level output selection (prefer over per-response `modalities`). */
  output_modalities?: Array<"audio" | "text">;
  audio: RealtimeAudioConfig;
  turn_detection?: {
    type: "server_vad";
    threshold?: number;
    prefix_padding_ms?: number;
    silence_duration_ms?: number;
  };
}

export interface SessionRecord {
  id: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  closedAt?: number;
  remoteCallId?: string;
  lastError?: string;
  eventCount: number;
  eventTypeCounts: Record<string, number>;
}

export interface DataChannelEventPayload {
  type: string;
  [key: string]: unknown;
}

export interface RealtimeCallRequest {
  sdp: string;
  session: SessionConfig;
}

export interface RealtimeCallResult {
  answerSdp: string;
  remoteCallId?: string;
}

export interface ClientSecretResult {
  value: string;
  expiresAt?: number;
  raw: Record<string, unknown>;
}
