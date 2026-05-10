import type { NextFunction, Request, Response } from "express";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

import type { InMemorySessionStore } from "../services/sessionStore";
import type { WebhookOutbox } from "../services/webhookOutbox";

export interface MetricsContext {
  registry: Registry;
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  handler: (req: Request, res: Response) => Promise<void>;
  redisReconnectsCounter: Counter<string>;
}

interface MetricsDeps {
  sessionStore: InMemorySessionStore;
  webhookOutbox: WebhookOutbox;
  redisReconnects: () => number;
  a2fRuntimeStats?: () => Array<{
    fps: number;
    queueDepthMs: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
  }>;
}

export function createMetricsContext(deps: MetricsDeps): MetricsContext {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "gateway_" });

  const httpRequestsTotal = new Counter({
    name: "gateway_http_requests_total",
    help: "Total HTTP requests handled by gateway",
    labelNames: ["method", "route", "status"],
    registers: [registry]
  });

  const httpRequestDuration = new Histogram({
    name: "gateway_http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry]
  });

  const realtimeSessionsActive = new Gauge({
    name: "gateway_realtime_sessions_active",
    help: "Number of realtime sessions in active status",
    registers: [registry],
    collect() {
      const active = deps.sessionStore.listSessions().filter((s) => s.status === "active").length;
      this.set(active);
    }
  });

  const webhookOutboxPending = new Gauge({
    name: "gateway_webhook_outbox_pending",
    help: "Pending webhook outbox items",
    registers: [registry],
    collect() {
      this.set(deps.webhookOutbox.getStats().pending);
    }
  });

  const webhookOutboxFailed = new Gauge({
    name: "gateway_webhook_outbox_failed",
    help: "Terminally failed webhook outbox items",
    registers: [registry],
    collect() {
      this.set(deps.webhookOutbox.getStats().terminalFailed);
    }
  });

  const redisReconnectsCounter = new Counter({
    name: "gateway_redis_reconnects_total",
    help: "Total redis reconnect attempts that succeeded",
    registers: [registry]
  });

  const a2fRuntimeFps = new Gauge({
    name: "gateway_a2f_runtime_fps",
    help: "Average A2F runtime FPS across active sessions",
    registers: [registry],
    collect() {
      const rows = deps.a2fRuntimeStats?.() ?? [];
      if (rows.length === 0) {
        this.set(0);
        return;
      }
      this.set(rows.reduce((acc, row) => acc + row.fps, 0) / rows.length);
    }
  });

  const a2fRuntimeQueueDepthMs = new Gauge({
    name: "gateway_a2f_runtime_queue_depth_ms",
    help: "Average A2F runtime audio queue depth in milliseconds",
    registers: [registry],
    collect() {
      const rows = deps.a2fRuntimeStats?.() ?? [];
      if (rows.length === 0) {
        this.set(0);
        return;
      }
      this.set(rows.reduce((acc, row) => acc + row.queueDepthMs, 0) / rows.length);
    }
  });

  const a2fRuntimeLatencyP95Ms = new Gauge({
    name: "gateway_a2f_runtime_latency_p95_ms",
    help: "Average A2F runtime p95 latency in milliseconds",
    registers: [registry],
    collect() {
      const rows = deps.a2fRuntimeStats?.() ?? [];
      if (rows.length === 0) {
        this.set(0);
        return;
      }
      this.set(rows.reduce((acc, row) => acc + row.p95LatencyMs, 0) / rows.length);
    }
  });

  // Bridge poll: каждые 10s synchronize external counter с prom-counter.
  let lastReported = 0;
  setInterval(() => {
    const current = deps.redisReconnects();
    if (current > lastReported) {
      redisReconnectsCounter.inc(current - lastReported);
      lastReported = current;
    }
  }, 10000).unref();

  void realtimeSessionsActive;
  void webhookOutboxPending;
  void webhookOutboxFailed;
  void a2fRuntimeFps;
  void a2fRuntimeQueueDepthMs;
  void a2fRuntimeLatencyP95Ms;

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const startNs = process.hrtime.bigint();
    res.on("finish", () => {
      const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
      const route = sanitizeRoute(req.route?.path, req.baseUrl, req.path);
      const labels = {
        method: req.method,
        route,
        status: String(res.statusCode)
      };
      httpRequestsTotal.inc(labels);
      httpRequestDuration.observe(labels, durationSec);
    });
    next();
  };

  const handler = async (_req: Request, res: Response): Promise<void> => {
    res.setHeader("Content-Type", registry.contentType);
    res.status(200).send(await registry.metrics());
  };

  return { registry, middleware, handler, redisReconnectsCounter };
}

function sanitizeRoute(routePath: string | undefined, baseUrl: string | undefined, fallback: string): string {
  if (routePath && typeof routePath === "string") {
    return `${baseUrl ?? ""}${routePath}` || fallback;
  }
  return fallback || "unknown";
}
