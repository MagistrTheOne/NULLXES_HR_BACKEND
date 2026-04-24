import { randomUUID } from "node:crypto";
import type { MeetingWebhookEvent } from "../types/meeting";
import type { MinimalRedisClient } from "./redisClient";

export type WebhookDeliveryStatus = "pending" | "delivered" | "terminal_failed";

export interface WebhookOutboxItem {
  id: string;
  event: MeetingWebhookEvent;
  idempotencyKey: string;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: number;
  lastAttemptAt?: number;
  lastError?: string;
  responseStatusCode?: number;
}

export class WebhookOutbox {
  private readonly items = new Map<string, WebhookOutboxItem>();
  private readonly idempotencyIndex = new Map<string, string>();

  constructor(
    private readonly options?: {
      redis?: MinimalRedisClient;
      prefix?: string;
    }
  ) {}

  async loadAll(): Promise<void> {
    const redis = this.options?.redis;
    if (!redis) return;
    const keys = await redis.scanAll(`${this.redisPrefix()}:webhook:*`);
    for (const key of keys) {
      const raw = await redis.get(key).catch(() => null);
      if (!raw) continue;
      const item = JSON.parse(raw) as WebhookOutboxItem;
      this.items.set(item.id, item);
      this.idempotencyIndex.set(item.idempotencyKey, item.id);
    }
  }

  enqueue(event: MeetingWebhookEvent, idempotencyKey: string): WebhookOutboxItem {
    const existingId = this.idempotencyIndex.get(idempotencyKey);
    if (existingId) {
      const existing = this.items.get(existingId);
      if (existing) {
        return existing;
      }
    }

    const item: WebhookOutboxItem = {
      id: randomUUID(),
      event,
      idempotencyKey,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: Date.now()
    };
    this.items.set(item.id, item);
    this.idempotencyIndex.set(idempotencyKey, item.id);
    this.persist(item);
    return item;
  }

  listReady(now: number): WebhookOutboxItem[] {
    return Array.from(this.items.values()).filter((item) => item.status === "pending" && item.nextAttemptAt <= now);
  }

  getItem(itemId: string): WebhookOutboxItem | undefined {
    return this.items.get(itemId);
  }

  markDelivered(itemId: string, responseStatusCode: number): void {
    const item = this.items.get(itemId);
    if (!item) return;
    item.status = "delivered";
    item.responseStatusCode = responseStatusCode;
    item.lastAttemptAt = Date.now();
    item.attemptCount += 1;
    this.persist(item);
  }

  markPendingRetry(itemId: string, nextAttemptAt: number, error: string, responseStatusCode?: number): void {
    const item = this.items.get(itemId);
    if (!item) return;
    item.lastAttemptAt = Date.now();
    item.attemptCount += 1;
    item.nextAttemptAt = nextAttemptAt;
    item.lastError = error;
    item.responseStatusCode = responseStatusCode;
    this.persist(item);
  }

  markTerminalFailure(itemId: string, error: string, responseStatusCode?: number): void {
    const item = this.items.get(itemId);
    if (!item) return;
    item.status = "terminal_failed";
    item.lastAttemptAt = Date.now();
    item.attemptCount += 1;
    item.lastError = error;
    item.responseStatusCode = responseStatusCode;
    this.persist(item);
  }

  getStats(): { pending: number; delivered: number; terminalFailed: number } {
    let pending = 0;
    let delivered = 0;
    let terminalFailed = 0;
    for (const item of this.items.values()) {
      if (item.status === "pending") pending += 1;
      if (item.status === "delivered") delivered += 1;
      if (item.status === "terminal_failed") terminalFailed += 1;
    }
    return { pending, delivered, terminalFailed };
  }

  private persist(item: WebhookOutboxItem): void {
    const redis = this.options?.redis;
    if (!redis) return;
    void redis.set(`${this.redisPrefix()}:webhook:${item.id}`, JSON.stringify(item)).catch(() => undefined);
  }

  private redisPrefix(): string {
    return this.options?.prefix ?? "nullxes:hr-ai";
  }
}
