import { env } from "../config/env";
import { logger } from "../logging/logger";
import { WebhookOutbox } from "./webhookOutbox";
import { WebhookSigner } from "./webhookSigner";

function classifyForRetry(statusCode: number): "delivered" | "retry" | "terminal" {
  if (statusCode >= 200 && statusCode < 300) return "delivered";
  if (statusCode === 429 || statusCode >= 500) return "retry";
  return "terminal";
}

function getBackoffMs(attemptNumber: number): number {
  const sequence = [1000, 3000, 10000, 30000];
  const idx = Math.max(0, Math.min(sequence.length - 1, attemptNumber - 1));
  return sequence[idx];
}

export class WebhookDispatcher {
  private timer?: NodeJS.Timeout;
  private readonly signer?: WebhookSigner;

  constructor(private readonly outbox: WebhookOutbox) {
    this.signer = env.JOBAI_WEBHOOK_SECRET ? new WebhookSigner(env.JOBAI_WEBHOOK_SECRET) : undefined;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.processReady();
    }, env.JOBAI_WEBHOOK_DISPATCH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async processReady(): Promise<void> {
    const now = Date.now();
    const readyItems = this.outbox.listReady(now);
    for (const item of readyItems) {
      await this.dispatch(item.id);
    }
  }

  private async dispatch(itemId: string): Promise<void> {
    const item = this.outbox.getItem(itemId);
    if (!item || item.status !== "pending" || item.nextAttemptAt > Date.now()) {
      return;
    }

    if (!env.JOBAI_WEBHOOK_ENABLED) {
      this.outbox.markDelivered(item.id, 204);
      return;
    }

    if (!env.JOBAI_WEBHOOK_URL || !this.signer) {
      this.outbox.markTerminalFailure(item.id, "Webhook strict mode is enabled but URL/secret is missing");
      return;
    }

    const body = JSON.stringify(item.event);
    const timestampMs = Date.now();
    const signature = this.signer.sign(timestampMs, body);

    try {
      const response = await fetch(env.JOBAI_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Timestamp": String(timestampMs),
          "X-Webhook-Signature": signature,
          "X-Idempotency-Key": item.idempotencyKey
        },
        body
      });

      const outcome = classifyForRetry(response.status);
      if (outcome === "delivered") {
        this.outbox.markDelivered(item.id, response.status);
        logger.info(
          {
            idempotencyKey: item.idempotencyKey,
            meetingId: item.event.internalMeetingId,
            responseStatus: response.status
          },
          "webhook delivered"
        );
        return;
      }

      if (outcome === "terminal") {
        this.outbox.markTerminalFailure(
          item.id,
          `Terminal webhook response status ${response.status}`,
          response.status
        );
        logger.error(
          {
            idempotencyKey: item.idempotencyKey,
            meetingId: item.event.internalMeetingId,
            responseStatus: response.status
          },
          "webhook terminal failure"
        );
        return;
      }

      const retryDelayMs = getBackoffMs(item.attemptCount + 1);
      if (item.attemptCount + 1 >= env.JOBAI_WEBHOOK_MAX_ATTEMPTS) {
        this.outbox.markTerminalFailure(
          item.id,
          `Retries exhausted. Last response status ${response.status}`,
          response.status
        );
        return;
      }

      this.outbox.markPendingRetry(
        item.id,
        Date.now() + retryDelayMs,
        `Retrying after status ${response.status}`,
        response.status
      );
      logger.warn(
        {
          idempotencyKey: item.idempotencyKey,
          meetingId: item.event.internalMeetingId,
          responseStatus: response.status,
          retryDelayMs
        },
        "webhook retry scheduled"
      );
    } catch (error) {
      const retryDelayMs = getBackoffMs(item.attemptCount + 1);
      if (item.attemptCount + 1 >= env.JOBAI_WEBHOOK_MAX_ATTEMPTS) {
        this.outbox.markTerminalFailure(
          item.id,
          error instanceof Error ? error.message : "Webhook dispatch failed"
        );
        return;
      }

      this.outbox.markPendingRetry(
        item.id,
        Date.now() + retryDelayMs,
        error instanceof Error ? error.message : "Webhook dispatch failed"
      );
    }
  }
}
