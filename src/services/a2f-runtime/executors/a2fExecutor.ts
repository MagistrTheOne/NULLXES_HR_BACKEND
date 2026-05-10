import type { BlendshapeValue } from "../contracts";

export interface A2FExecutor {
  execute(input: { pcm16: Int16Array; sampleRateHz: number }): Promise<{ blendshapes: BlendshapeValue[] }>;
}

const DEFAULT_BLENDSHAPES = [
  "jawOpen",
  "mouthFunnel",
  "mouthPucker",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthPressLeft",
  "mouthPressRight",
  "mouthLowerDownLeft",
  "mouthLowerDownRight"
];

/**
 * Placeholder until C++ executor RPC bridge is enabled in runtime service.
 * Uses audio RMS to produce deterministic blendshape magnitudes.
 */
export class LocalA2FExecutor implements A2FExecutor {
  async execute(input: { pcm16: Int16Array; sampleRateHz: number }): Promise<{ blendshapes: BlendshapeValue[] }> {
    void input.sampleRateHz;
    const power = rms(input.pcm16);
    const blendshapes = DEFAULT_BLENDSHAPES.map((name, idx) => ({
      name,
      value: clamp01(power * (1 + (idx % 3) * 0.15))
    }));
    return { blendshapes };
  }
}

function rms(samples: Int16Array): number {
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

