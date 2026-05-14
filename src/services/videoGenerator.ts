import { env } from "../config/env";
import type { RunpodWorkerClient, RunpodGenerateClipResponse } from "./runpodWorkerClient";

export type VideoModel = "arachne" | "arachne_ultra_avatar" | "arachne_ultra_video" | "behavior_static" | "none";

export type AudioWindow = {
  /** base64 PCM16 LE audio for this clip window (authoritative OpenAI clock). */
  pcm16Base64: string;
  audioStartMs: number;
  durationMs: number;
  sampleRateHz: 16000 | 24000 | 48000;
};

export type GeneratedClip = {
  model: VideoModel;
  fps: number;
  width: number;
  height: number;
  audioStartMs: number;
  durationMs: number;
  frames: Array<{ ptsMs: number; i420Base64: string }>;
  telemetry: RunpodGenerateClipResponse["telemetry"];
};

export interface VideoGenerator {
  warmup(): Promise<void>;
  generateClip(input: { meetingId: string; sessionId: string; window: AudioWindow; fps: number; numFrames: number; seed?: number }): Promise<GeneratedClip>;
  unload(): Promise<void>;
}

export function createVideoGenerator(_worker: RunpodWorkerClient): VideoGenerator {
  const model = env.VIDEO_MODEL as VideoModel;
  return {
    warmup: async () => undefined,
    generateClip: async () => {
      throw new Error(`VIDEO_MODEL=${model} does not support legacy generateClip; use ARACHNE avatar_frames or /v1/arachne/generate`);
    },
    unload: async () => undefined
  } satisfies VideoGenerator;
}

