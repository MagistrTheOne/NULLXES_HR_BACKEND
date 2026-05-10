type RingSnapshot = {
  depthSamples: number;
  depthMs: number;
  writeSeq: number;
  readSeq: number;
};

/**
 * SPSC PCM16 ring buffer based on atomic cursors.
 * The ring stores samples only; timing is handled by the caller.
 */
export class LockFreePcmRingBuffer {
  private readonly sampleRateHz: number;
  private readonly capacitySamples: number;
  private readonly data: Int16Array;
  private readonly cursors: Int32Array;
  private droppedSamples = 0;

  constructor(input: { sampleRateHz: number; capacityMs: number }) {
    this.sampleRateHz = input.sampleRateHz;
    this.capacitySamples = Math.max(1, Math.floor((input.capacityMs * input.sampleRateHz) / 1000));
    this.data = new Int16Array(this.capacitySamples);
    this.cursors = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
    // 0 = read cursor, 1 = write cursor
  }

  write(samples: Int16Array): { accepted: number; dropped: number } {
    if (samples.length === 0) {
      return { accepted: 0, dropped: 0 };
    }

    let read = Atomics.load(this.cursors, 0);
    let write = Atomics.load(this.cursors, 1);
    const used = write - read;
    const free = this.capacitySamples - used;
    let dropped = 0;

    if (samples.length > free) {
      const overflow = samples.length - free;
      read += overflow;
      dropped = overflow;
      this.droppedSamples += overflow;
      Atomics.store(this.cursors, 0, read);
    }

    for (let i = 0; i < samples.length; i += 1) {
      this.data[(write + i) % this.capacitySamples] = samples[i]!;
    }
    write += samples.length;
    Atomics.store(this.cursors, 1, write);
    return { accepted: samples.length, dropped };
  }

  readWindow(windowSamples: number, hopSamples: number): Int16Array | null {
    if (windowSamples <= 0 || hopSamples <= 0) {
      return null;
    }
    const read = Atomics.load(this.cursors, 0);
    const write = Atomics.load(this.cursors, 1);
    const available = write - read;
    if (available < windowSamples) {
      return null;
    }

    const out = new Int16Array(windowSamples);
    for (let i = 0; i < windowSamples; i += 1) {
      out[i] = this.data[(read + i) % this.capacitySamples]!;
    }
    Atomics.store(this.cursors, 0, read + hopSamples);
    return out;
  }

  getSnapshot(): RingSnapshot {
    const read = Atomics.load(this.cursors, 0);
    const write = Atomics.load(this.cursors, 1);
    const depthSamples = Math.max(0, write - read);
    return {
      readSeq: read,
      writeSeq: write,
      depthSamples,
      depthMs: (depthSamples / this.sampleRateHz) * 1000
    };
  }

  getDroppedSamples(): number {
    return this.droppedSamples;
  }
}

