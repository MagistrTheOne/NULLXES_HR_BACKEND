import { logger } from "../logging/logger";
import type { AvatarGenerateJobRecord, AvatarGenerateJobStore } from "./avatarGenerateJobStore";

function processingStartedMs(job: AvatarGenerateJobRecord): number {
  if (job.processingStartedAt) {
    const t = Date.parse(job.processingStartedAt);
    if (Number.isFinite(t)) return t;
  }
  return job.updatedAtMs ?? job.createdAtMs;
}

/**
 * Marks long-running `processing` jobs as failed (operator / worker crash recovery).
 */
export async function sweepStaleAvatarGenerateJobs(
  jobStore: AvatarGenerateJobStore,
  staleMs: number
): Promise<number> {
  const jobs = await jobStore.listJobs();
  let n = 0;
  for (const job of jobs) {
    if (job.state !== "processing") continue;
    const started = processingStartedMs(job);
    if (Date.now() - started < staleMs) continue;
    const failedAt = new Date().toISOString();
    const next: AvatarGenerateJobRecord = {
      ...job,
      state: "failed",
      failedAt,
      errorMessage: "processing_stale",
      updatedAtMs: Date.now()
    };
    await jobStore.save(next);
    n += 1;
    logger.warn({ jobId: job.id, staleMs }, "avatar generate job marked failed (processing stale)");
  }
  return n;
}

export function startAvatarGenerateStaleSweeper(opts: {
  jobStore: AvatarGenerateJobStore;
  staleMs: number;
  intervalMs: number;
}): () => void {
  const tick = (): void => {
    void sweepStaleAvatarGenerateJobs(opts.jobStore, opts.staleMs).catch((err) => {
      logger.warn({ err }, "avatar generate stale sweep failed");
    });
  };
  const handle = setInterval(tick, opts.intervalMs);
  if (typeof handle === "object" && handle !== null && "unref" in handle) {
    (handle as NodeJS.Timeout).unref();
  }
  tick();
  return () => clearInterval(handle);
}
