export type AudioChunk = {
  timestampMs: number;
  sampleRateHz: 16_000;
  pcm16: Int16Array;
};

export type BlendshapeValue = {
  name: string;
  value: number;
};

export type EmotionScores = Record<string, number>;

export type RuntimeFrameEnvelope = {
  meetingId: string;
  timestamp: number;
  blendshapes: BlendshapeValue[];
  emotions: EmotionScores;
  audioPower: number;
  latencyMs: number;
};

export type RuntimeFrameFormat = "json" | "protobuf";

export type SessionRuntimeStats = {
  meetingId: string;
  active: boolean;
  fps: number;
  queueDepthMs: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  droppedFrames: number;
  droppedSamples: number;
  totalFrames: number;
  outputQueueDepth: number;
  gpuSlot: number | null;
};

export type RuntimeSessionConfig = {
  meetingId: string;
  sampleRateHz?: 16_000;
  windowMs?: number;
  hopMs?: number;
  maxQueueMs?: number;
  targetFps?: number;
  enableProtobuf?: boolean;
};

export type RuntimeFrameSubscriber = {
  format: RuntimeFrameFormat;
  onFrame: (frame: RuntimeFrameEnvelope | Uint8Array) => void;
  onClose?: () => void;
};

export type RuntimeIngestResult = {
  acceptedSamples: number;
  droppedSamples: number;
  queueDepthMs: number;
};

