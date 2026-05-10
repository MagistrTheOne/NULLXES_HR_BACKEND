import type { EmotionScores } from "../contracts";

export interface A2EMExecutor {
  execute(input: { pcm16: Int16Array; sampleRateHz: number }): Promise<{ emotions: EmotionScores }>;
}

/**
 * Placeholder emotion inference with deterministic power-based splits.
 */
export class LocalA2EMExecutor implements A2EMExecutor {
  async execute(input: { pcm16: Int16Array; sampleRateHz: number }): Promise<{ emotions: EmotionScores }> {
    void input.sampleRateHz;
    const power = rms(input.pcm16);
    const calm = clamp01(1 - power * 1.8);
    const excited = clamp01(power * 1.4);
    const neutral = clamp01(1 - Math.abs(calm - excited));
    return {
      emotions: {
        calm,
        excited,
        neutral
      }
    };
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

