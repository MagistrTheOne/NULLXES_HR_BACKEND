export async function withRetries<T>(
  fn: () => Promise<T>,
  options: { attempts: number; backoffMs: number[]; isRetryable?: (err: unknown) => boolean }
): Promise<T> {
  const attempts = Math.max(1, options.attempts);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = options.isRetryable ? options.isRetryable(err) : true;
      if (!retryable || attempt >= attempts) break;
      const delay = options.backoffMs[Math.min(attempt - 1, options.backoffMs.length - 1)] ?? 200;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

