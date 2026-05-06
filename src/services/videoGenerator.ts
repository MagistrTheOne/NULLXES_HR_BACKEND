import { env } from "../config/env";
import type { RunpodWorkerClient, RunpodGenerateClipResponse } from "./runpodWorkerClient";

export type VideoModel = "wan" | "echomimic" | "none";

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

export class EchoMimicGenerator implements VideoGenerator {
  private readonly worker: RunpodWorkerClient;

  constructor(worker: RunpodWorkerClient) {
    this.worker = worker;
  }

  async warmup(): Promise<void> {
    // Worker can implement its own warmup route; keep best-effort here.
    return;
  }

  async generateClip(input: { meetingId: string; sessionId: string; window: AudioWindow; fps: number; numFrames: number; seed?: number }): Promise<GeneratedClip> {
    const resp = await this.worker.generateClip({
      meetingId: input.meetingId,
      sessionId: input.sessionId,
      epoch: 0,
      audioPcm16Base64: input.window.pcm16Base64,
      audioSampleRate: input.window.sampleRateHz,
      fps: 25,
      width: 512,
      height: 512,
      numFrames: (input.numFrames === 105 ? 105 : input.numFrames === 57 ? 57 : input.numFrames === 49 ? 49 : 25) as 25 | 49 | 57 | 105,
      numInferenceSteps: 5,
      seed: input.seed,
      prompt: "A realistic HR avatar is speaking naturally to camera, stable face, realistic lipsync, professional upper body framing, centered face, cinematic lighting, sharp eyes.",
      negativePrompt:
        "blurry, distorted face, unstable eyes, warped mouth, bad teeth, face melting, duplicate face, watermark, text"
    });
    return {
      model: "echomimic",
      fps: resp.fps,
      width: resp.width,
      height: resp.height,
      audioStartMs: input.window.audioStartMs,
      durationMs: input.window.durationMs,
      frames: resp.frames,
      telemetry: resp.telemetry
    };
  }

  async unload(): Promise<void> {
    return;
  }
}

export function createVideoGenerator(worker: RunpodWorkerClient): VideoGenerator {
  const model = env.VIDEO_MODEL as VideoModel;
  if (model === "echomimic") return new EchoMimicGenerator(worker);
  return {
    warmup: async () => undefined,
    generateClip: async () => {
      throw new Error(`VIDEO_MODEL=${model} does not support generateClip`);
    },
    unload: async () => undefined
  } satisfies VideoGenerator;
}

