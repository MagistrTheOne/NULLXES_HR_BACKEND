export type AudioChunk = {
  startMs: number;
  sampleRateHz: number;
  pcm16: Int16Array;
};

/**
 * Bounded audio ring buffer for authoritative PCM16 audio clock.
 * Stores time-aligned PCM16 chunks; supports extracting windows for video gen.
 */
export class AudioRingBuffer {
  private readonly maxMs: number;
  private chunks: AudioChunk[] = [];

  constructor(options: { maxMs: number }) {
    this.maxMs = options.maxMs;
  }

  append(chunk: AudioChunk): void {
    if (chunk.pcm16.length === 0) return;
    this.chunks.push(chunk);
    this.trim();
  }

  /**
   * Returns a best-effort PCM16 window for [startMs, startMs+durationMs).
   * Current implementation assumes constant sampleRate and contiguous-ish chunks.
   */
  readWindow(input: { startMs: number; durationMs: number; sampleRateHz: number }): Int16Array {
    const targetSamples = Math.max(0, Math.floor((input.durationMs * input.sampleRateHz) / 1000));
    const out = new Int16Array(targetSamples);
    if (targetSamples === 0) return out;

    const windowEnd = input.startMs + input.durationMs;
    let writePos = 0;

    for (const c of this.chunks) {
      if (c.sampleRateHz !== input.sampleRateHz) continue;
      const chunkDurationMs = (c.pcm16.length / c.sampleRateHz) * 1000;
      const cEnd = c.startMs + chunkDurationMs;
      if (cEnd <= input.startMs) continue;
      if (c.startMs >= windowEnd) break;

      const overlapStartMs = Math.max(input.startMs, c.startMs);
      const overlapEndMs = Math.min(windowEnd, cEnd);
      const overlapMs = overlapEndMs - overlapStartMs;
      if (overlapMs <= 0) continue;

      const srcStartSamples = Math.floor(((overlapStartMs - c.startMs) * c.sampleRateHz) / 1000);
      const overlapSamples = Math.min(
        c.pcm16.length - srcStartSamples,
        Math.floor((overlapMs * c.sampleRateHz) / 1000)
      );
      if (overlapSamples <= 0) continue;

      const toCopy = Math.min(overlapSamples, out.length - writePos);
      out.set(c.pcm16.subarray(srcStartSamples, srcStartSamples + toCopy), writePos);
      writePos += toCopy;
      if (writePos >= out.length) break;
    }

    return out;
  }

  oldestMs(): number | null {
    return this.chunks.length > 0 ? this.chunks[0]!.startMs : null;
  }

  newestMs(): number | null {
    if (this.chunks.length === 0) return null;
    const c = this.chunks[this.chunks.length - 1]!;
    const durationMs = (c.pcm16.length / c.sampleRateHz) * 1000;
    return c.startMs + durationMs;
  }

  clear(): void {
    this.chunks = [];
  }

  private trim(): void {
    // Keep only last maxMs of audio based on newestMs.
    const newest = this.newestMs();
    if (newest === null) return;
    const cutoff = newest - this.maxMs;
    while (this.chunks.length > 1) {
      const first = this.chunks[0]!;
      const durMs = (first.pcm16.length / first.sampleRateHz) * 1000;
      if (first.startMs + durMs >= cutoff) break;
      this.chunks.shift();
    }
  }
}

