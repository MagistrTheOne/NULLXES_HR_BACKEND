export class MasterClock {
  private readonly startedAtNs: bigint;

  constructor() {
    this.startedAtNs = process.hrtime.bigint();
  }

  nowNs(): bigint {
    return process.hrtime.bigint() - this.startedAtNs;
  }

  nowMs(): number {
    return Number(this.nowNs() / 1_000_000n);
  }

  elapsedMsSince(fromNs: bigint): number {
    const now = this.nowNs();
    if (now <= fromNs) return 0;
    return Number((now - fromNs) / 1_000_000n);
  }

  toPtsMsFromDuration(durationMs: number): number {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return this.nowMs();
    return this.nowMs() + durationMs;
  }
}

