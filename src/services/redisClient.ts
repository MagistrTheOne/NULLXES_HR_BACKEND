import { createConnection, type Socket } from "node:net";
import { URL } from "node:url";

import { logger } from "../logging/logger";

export type RedisValue = string | number | null | RedisValue[];

interface PendingCommand {
  resolve: (value: RedisValue) => void;
  reject: (reason: unknown) => void;
  payload: Buffer;
}

export interface RedisClientOptions {
  url: string;
  maxReconnectDelayMs: number;
  heartbeatMs: number;
  commandQueueLimit: number;
  onReconnect?: () => void;
}

/**
 * Минимальный RESP-клиент на чистом node:net.
 * Поддерживает GET/SET/DEL/SCAN/PING + повторное подключение с backoff и heartbeat.
 * Не подходит для pub/sub и pipelining — для нужд gateway этого достаточно.
 */
export class MinimalRedisClient {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private inflight: PendingCommand[] = [];
  private waiting: PendingCommand[] = [];
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private closedByUser = false;

  private readonly host: string;
  private readonly port: number;
  private readonly password?: string;
  private readonly db?: number;
  private readonly maxReconnectDelayMs: number;
  private readonly heartbeatMs: number;
  private readonly commandQueueLimit: number;
  private readonly onReconnect?: () => void;

  constructor(options: RedisClientOptions) {
    const parsed = new URL(options.url);
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      throw new Error("REDIS_URL must use redis:// or rediss:// scheme");
    }
    if (parsed.protocol === "rediss:") {
      throw new Error("rediss:// (TLS) is not supported by MinimalRedisClient");
    }
    this.host = parsed.hostname;
    this.port = parsed.port ? Number(parsed.port) : 6379;
    this.password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    const dbPath = parsed.pathname?.replace("/", "").trim();
    this.db = dbPath ? Number(dbPath) : undefined;

    this.maxReconnectDelayMs = options.maxReconnectDelayMs;
    this.heartbeatMs = options.heartbeatMs;
    this.commandQueueLimit = options.commandQueueLimit;
    this.onReconnect = options.onReconnect;
  }

  async connect(): Promise<void> {
    if (this.connected && this.socket) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.closedByUser = false;
    this.connectPromise = this.openSocket()
      .then(() => {
        this.startHeartbeat();
      })
      .finally(() => {
        this.connectPromise = null;
      });
    return this.connectPromise;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async ping(): Promise<string> {
    const value = await this.command(["PING"]);
    return typeof value === "string" ? value : "PONG";
  }

  async get(key: string): Promise<string | null> {
    const value = await this.command(["GET", key]);
    if (typeof value === "string" || value === null) {
      return value;
    }
    return value === undefined ? null : String(value);
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    if (typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0) {
      await this.command(["SET", key, value, "PX", String(Math.floor(ttlMs))]);
      return;
    }
    await this.command(["SET", key, value]);
  }

  async del(key: string): Promise<void> {
    await this.command(["DEL", key]);
  }

  /** SCAN с ленивой пагинацией. Возвращает все ключи под match (без блокировки KEYS *). */
  async scanAll(match: string, count = 200): Promise<string[]> {
    const result: string[] = [];
    let cursor = "0";
    do {
      const reply = await this.command(["SCAN", cursor, "MATCH", match, "COUNT", String(count)]);
      if (!Array.isArray(reply) || reply.length < 2) {
        break;
      }
      const nextCursor = reply[0];
      const keys = reply[1];
      cursor = typeof nextCursor === "string" ? nextCursor : String(nextCursor ?? "0");
      if (Array.isArray(keys)) {
        for (const key of keys) {
          if (typeof key === "string") {
            result.push(key);
          }
        }
      }
    } while (cursor !== "0");
    return result;
  }

  async quit(): Promise<void> {
    this.closedByUser = true;
    this.stopHeartbeat();
    this.cancelReconnect();
    if (!this.socket) {
      return;
    }
    try {
      await this.command(["QUIT"]);
    } catch {
      // socket already closing
    }
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.failAllPending(new Error("Redis client closed"));
  }

  private async command(parts: string[]): Promise<RedisValue> {
    const payload = encodeCommand(parts);

    if (!this.connected || !this.socket) {
      return this.enqueueWaiting(payload);
    }

    return new Promise<RedisValue>((resolve, reject) => {
      const pending: PendingCommand = { resolve, reject, payload };
      this.inflight.push(pending);
      const ok = this.socket?.write(payload);
      if (ok === false) {
        // backpressure on socket — pending уже в inflight, ответ придёт когда придёт
      }
    });
  }

  private enqueueWaiting(payload: Buffer): Promise<RedisValue> {
    if (this.waiting.length >= this.commandQueueLimit) {
      return Promise.reject(new Error("Redis command queue overflow (backpressure)"));
    }
    return new Promise<RedisValue>((resolve, reject) => {
      this.waiting.push({ resolve, reject, payload });
      void this.scheduleReconnect();
    });
  }

  private async openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      let settled = false;

      socket.setNoDelay(true);
      socket.setKeepAlive(true, 15000);

      const onError = (error: Error): void => {
        logger.warn({ err: error, host: this.host, port: this.port }, "redis socket error");
        if (!settled) {
          settled = true;
          this.connected = false;
          reject(error);
        }
        this.handleDisconnect(error);
      };

      const onClose = (): void => {
        this.handleDisconnect(new Error("redis socket closed"));
      };

      socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.flushPending();
      });
      socket.on("error", onError);
      socket.on("close", onClose);

      socket.once("connect", () => {
        void (async () => {
          try {
            this.connected = true;
            if (this.password) {
              await this.command(["AUTH", this.password]);
            }
            if (Number.isInteger(this.db) && (this.db as number) >= 0) {
              await this.command(["SELECT", String(this.db)]);
            }
            // sanity ping
            await this.command(["PING"]);
            settled = true;
            this.reconnectAttempt = 0;
            this.drainWaiting();
            resolve();
          } catch (error) {
            settled = true;
            reject(error);
          }
        })();
      });
    });
  }

  private drainWaiting(): void {
    if (!this.connected || !this.socket) return;
    while (this.waiting.length > 0) {
      const pending = this.waiting.shift();
      if (!pending) continue;
      this.inflight.push(pending);
      this.socket.write(pending.payload);
    }
  }

  private handleDisconnect(reason: Error): void {
    if (!this.connected && !this.socket) {
      return;
    }
    this.connected = false;
    this.socket = null;
    this.stopHeartbeat();

    // fail in-flight commands so callers don't hang forever
    while (this.inflight.length > 0) {
      const pending = this.inflight.shift();
      pending?.reject(reason);
    }

    if (this.closedByUser) {
      return;
    }
    void this.scheduleReconnect();
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.closedByUser) return;
    if (this.connectPromise) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempt += 1;
    const baseDelay = Math.min(200 * 2 ** (this.reconnectAttempt - 1), this.maxReconnectDelayMs);
    const jitter = Math.floor(Math.random() * Math.min(500, baseDelay * 0.2));
    const delay = baseDelay + jitter;

    logger.warn(
      { attempt: this.reconnectAttempt, delayMs: delay, host: this.host, port: this.port },
      "redis reconnect scheduled"
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket()
        .then(() => {
          this.startHeartbeat();
          this.onReconnect?.();
          logger.info({ host: this.host, port: this.port }, "redis reconnected");
        })
        .catch((error) => {
          logger.warn({ err: error }, "redis reconnect attempt failed");
          void this.scheduleReconnect();
        });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      this.command(["PING"]).catch((error) => {
        logger.warn({ err: error }, "redis heartbeat failed");
        this.handleDisconnect(error instanceof Error ? error : new Error("heartbeat failed"));
      });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private failAllPending(reason: Error): void {
    while (this.inflight.length > 0) {
      this.inflight.shift()?.reject(reason);
    }
    while (this.waiting.length > 0) {
      this.waiting.shift()?.reject(reason);
    }
  }

  private flushPending(): void {
    while (this.inflight.length > 0) {
      const parsed = parseValue(this.buffer, 0);
      if (!parsed) {
        return;
      }
      this.buffer = this.buffer.slice(parsed.nextOffset);
      const pending = this.inflight.shift();
      if (!pending) continue;
      if (parsed.error) {
        pending.reject(parsed.error);
        continue;
      }
      pending.resolve(parsed.value);
    }
  }
}

function encodeCommand(parts: string[]): Buffer {
  const head = Buffer.from(`*${parts.length}\r\n`, "utf8");
  const chunks: Buffer[] = [head];
  for (const part of parts) {
    const encoded = Buffer.from(part, "utf8");
    chunks.push(Buffer.from(`$${encoded.length}\r\n`, "utf8"));
    chunks.push(encoded);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  return Buffer.concat(chunks);
}

interface ParsedValue {
  value: RedisValue;
  nextOffset: number;
  error?: Error;
}

function parseValue(buffer: Buffer, offset: number): ParsedValue | null {
  if (buffer.length <= offset) {
    return null;
  }
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd === -1) {
    return null;
  }
  const line = buffer.toString("utf8", offset + 1, lineEnd);
  const next = lineEnd + 2;

  if (type === "+") {
    return { value: line, nextOffset: next };
  }
  if (type === "-") {
    return { value: null, nextOffset: next, error: new Error(line) };
  }
  if (type === ":") {
    return { value: Number(line), nextOffset: next };
  }
  if (type === "$") {
    const size = Number(line);
    if (size === -1) {
      return { value: null, nextOffset: next };
    }
    const bodyEnd = next + size;
    if (buffer.length < bodyEnd + 2) {
      return null;
    }
    const value = buffer.toString("utf8", next, bodyEnd);
    return { value, nextOffset: bodyEnd + 2 };
  }
  if (type === "*") {
    const count = Number(line);
    if (count === -1) {
      return { value: null, nextOffset: next };
    }
    const values: RedisValue[] = [];
    let cursor = next;
    for (let index = 0; index < count; index += 1) {
      const nested = parseValue(buffer, cursor);
      if (!nested) return null;
      if (nested.error) {
        return { value: null, nextOffset: nested.nextOffset, error: nested.error };
      }
      values.push(nested.value);
      cursor = nested.nextOffset;
    }
    return { value: values, nextOffset: cursor };
  }
  return { value: null, nextOffset: next, error: new Error(`Unsupported RESP type: ${type}`) };
}
