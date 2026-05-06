import { logger } from "../logging/logger";

export type ClipFrame = {
  ptsMs: number;
  /** base64 encoded frame bytes */
  b64: string;
  /** "i420" is publish-ready for wrtc RTCVideoSource */
  format: "i420";
};

export type AvatarClip = {
  id: string;
  epoch: number;
  fps: number;
  width: number;
  height: number;
  frames: ClipFrame[];
  audioStartMs: number;
  durationMs: number;
};

export type ClipBufferStats = {
  bufferedSeconds: number;
  droppedFrames: number;
  clipsQueued: number;
  epoch: number;
};

/**
 * Interruption-aware rolling clip buffer.
 * - Enqueue clips tagged with `epoch`
 * - Playback queries frame by authoritative audio timestamp
 * - On interruption: increment epoch + invalidate old clips
 */
export class ClipBuffer {
  private readonly maxBufferMs: number;
  private clips: AvatarClip[] = [];
  private droppedFrames = 0;
  private epoch = 0;
  private lastFrame: { i420: Buffer; width: number; height: number } | null = null;

  constructor(options: { maxBufferMs: number }) {
    this.maxBufferMs = options.maxBufferMs;
  }

  getEpoch(): number {
    return this.epoch;
  }

  invalidateEpoch(reason: string): number {
    this.epoch += 1;
    this.clips = [];
    logger.warn({ epoch: this.epoch, reason }, "clip buffer epoch invalidated");
    return this.epoch;
  }

  enqueueClip(clip: AvatarClip): void {
    if (clip.epoch !== this.epoch) {
      // stale response
      this.droppedFrames += clip.frames.length;
      return;
    }
    this.clips.push(clip);
    this.clips.sort((a, b) => a.audioStartMs - b.audioStartMs);
    this.trimBefore(Date.now() - this.maxBufferMs);
    this.trimOverflow();
  }

  trimBefore(cutoffMs: number): void {
    while (this.clips.length > 1) {
      const first = this.clips[0]!;
      const end = first.audioStartMs + first.durationMs;
      if (end >= cutoffMs) break;
      this.clips.shift();
    }
  }

  getBufferedSeconds(nowMs: number): number {
    const last = this.clips[this.clips.length - 1];
    if (!last) return 0;
    const end = last.audioStartMs + last.durationMs;
    return Math.max(0, (end - nowMs) / 1000);
  }

  /**
   * Return frame at absolute audio clock time.
   * If missing, return lastFrame (hold-last-frame degradation).
   */
  getFrameAtTime(timestampMs: number): { i420: Buffer; width: number; height: number } | null {
    const clip = this.clips.find(
      (c) => timestampMs >= c.audioStartMs && timestampMs < c.audioStartMs + c.durationMs
    );
    if (!clip) {
      this.droppedFrames += 1;
      return this.lastFrame;
    }
    const offsetMs = timestampMs - clip.audioStartMs;
    // Prefer ptsMs if provided; fall back to index calculation.
    let frame = clip.frames.find((f) => f.ptsMs <= offsetMs && offsetMs < f.ptsMs + 1000 / clip.fps);
    if (!frame) {
      const frameIndex = Math.min(
        clip.frames.length - 1,
        Math.max(0, Math.floor((offsetMs / 1000) * clip.fps))
      );
      frame = clip.frames[frameIndex];
    }
    if (!frame) {
      this.droppedFrames += 1;
      return this.lastFrame;
    }
    const i420 = Buffer.from(frame.b64, "base64");
    const out = { i420, width: clip.width, height: clip.height };
    this.lastFrame = out;
    return out;
  }

  stats(nowMs: number): ClipBufferStats {
    return {
      bufferedSeconds: this.getBufferedSeconds(nowMs),
      droppedFrames: this.droppedFrames,
      clipsQueued: this.clips.length,
      epoch: this.epoch
    };
  }

  private trimOverflow(): void {
    let total = this.totalBufferedMs();
    while (this.clips.length > 1 && total > this.maxBufferMs) {
      const removed = this.clips.shift();
      total -= removed?.durationMs ?? 0;
      logger.warn({ removedClip: removed?.id, totalMs: total }, "clip buffer trimmed (overflow)");
    }
  }

  private totalBufferedMs(): number {
    return this.clips.reduce((acc, clip) => acc + (clip.durationMs ?? 0), 0);
  }
}

