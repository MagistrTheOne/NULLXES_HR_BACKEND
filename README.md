# Realtime WebRTC Gateway (Backend Only)

Production-oriented Node.js + Express + TypeScript service that:
- brokers WebRTC SDP negotiation and session control to OpenAI Realtime (`gpt-realtime`)
- orchestrates meeting status lifecycle (no Zoom integration)
- delivers strict webhook status events to JobAI backend with idempotency and retry

## Project Structure

```text
backend/realtime-gateway
├── src
│   ├── app.ts
│   ├── index.ts
│   ├── config/env.ts
│   ├── logging/logger.ts
│   ├── middleware/errorHandler.ts
│   ├── middleware/requestId.ts
│   ├── routes/meeting.routes.ts
│   ├── routes/realtime.routes.ts
│   ├── services/meetingOrchestrator.ts
│   ├── services/meetingStateMachine.ts
│   ├── services/meetingStore.ts
│   ├── services/openaiRealtimeClient.ts
│   ├── services/postMeetingProcessor.ts
│   ├── services/sessionStore.ts
│   ├── services/webhookDispatcher.ts
│   ├── services/webhookOutbox.ts
│   ├── services/webhookSigner.ts
│   ├── types/meeting.ts
│   └── types/realtime.ts
├── .env.example
├── Dockerfile
├── package.json
├── scripts/generate-real-offer.mjs
└── tsconfig.json
```

## API Endpoints

- `GET /health`
  - Liveness/readiness probe.
- `POST /realtime/session`
  - Accepts SDP offer (`Content-Type: application/sdp`).
  - Calls OpenAI unified endpoint `POST /v1/realtime/calls`.
  - Returns SDP answer (`Content-Type: application/sdp`) with `x-session-id`.
- `GET /realtime/token`
  - Calls OpenAI ephemeral key endpoint `POST /v1/realtime/client_secrets`.
  - Returns `{ sessionId, token, expiresAt, session }`.
- `POST /realtime/session/:sessionId/events`
  - Accepts DataChannel event JSON and records per-session telemetry.
- `DELETE /realtime/session/:sessionId`
  - Marks session closed.
- `POST /meetings/start`
  - Creates meeting context and transitions `pending -> starting -> in_meeting`.
  - **Integrator JSON:** `{ "meetingId": "<canonical id>", "triggerSource?": "…", "metadata?": {}, "sessionId?": "…" }`. Deprecated field name: `internalMeetingId` (same meaning as `meetingId`). `triggerSource` is optional (stored as `unspecified` when omitted).
  - **JobAI control** (body has numeric `meetingId` + bearer `meetingControlKey`): `{ "meetingId": <number>, "agentRTMPURL?": "rtmps://…" }`. Response: `{ ok, meetingId: "nullxes-meeting-…", numericMeetingId, status }`.
- `POST /meetings/stop`
  - JobAI control: same bearer; body `{ "meetingId": <number> | "nullxes-meeting-<id>", "stopReason": "candidate_leaved" | "candidate_stopped_ui" }`. Response: `{ ok, meetingId: "nullxes-meeting-…", numericMeetingId, status, stopReason }`.
- `POST /meetings/:meetingId/stop`
  - Stops meeting with terminal state: `stopped_during_meeting` or `completed`.
- `POST /meetings/:meetingId/fail`
  - Marks meeting as `failed_audio_pool_busy` or `failed_connect_ws_audio`.
- `GET /meetings/:meetingId`
  - Returns current meeting state with transition history.
- `GET /meetings`
  - Returns all meeting records.
- `GET /meetings/:meetingId/admission/candidate?participantId=…`
  - Returns current admission slot state (`owner`, `pending`, `ownerActive`, `canCurrentParticipantRejoin`).
- `POST /meetings/:meetingId/admission/candidate/acquire`
  - Body `{ participantId, displayName? }`. Returns `200` if granted, `423` if waiting for HR approval.
- `POST /meetings/:meetingId/admission/candidate/release`
  - Body `{ participantId, reason? }`. Frees the slot; first pending entry is auto-promoted to owner.
- `POST /meetings/:meetingId/admission/candidate/decision`
  - Body `{ participantId, action: "approve" | "deny", decidedBy? }`. HR override.
- `GET /ops/webhooks`
  - Returns in-memory webhook queue stats.
- `GET /health/ready`
  - Readiness probe: checks Redis (when enabled) and OpenAI key. Returns `503` if degraded.
- `GET /metrics`
  - Prometheus exposition (when `METRICS_ENABLED=true`, default).

## Session Lifecycle

- Sessions are tracked in-memory (`Map`) with status states:
  - `starting -> active -> closing -> closed | error`
- Session metadata includes:
  - `createdAt`, `lastActivityAt`, `updatedAt`, `remoteCallId`, `eventTypeCounts`, error context
- Inactivity sweeper closes active sessions after `SESSION_IDLE_TIMEOUT_MS`.

## Security

- OpenAI API key is read only from server environment.
- API key is never returned to clients.
- SDP payload is validated:
  - Content-Type check (`application/sdp`)
  - Non-empty body
  - Size guard (`SDP_MAX_BYTES`)
  - Basic SDP precheck (`v=0`)

## Observability

- Structured JSON logging via `pino` + `pino-http`.
- Request correlation via `x-request-id`.
- Session correlation via generated `sessionId`.
- Error logs include upstream status/error bodies (with secret redaction).

## Meeting Orchestration (No Zoom)

State machine:
- `pending`
- `starting`
- `in_meeting`
- `failed_audio_pool_busy`
- `failed_connect_ws_audio`
- `stopped_during_meeting`
- `completed`

Each transition:
- is validated by `MeetingStateMachine`
- is written to in-memory meeting history
- produces webhook outbox event `meeting.status.changed` with **`meetingId`** (canonical string) and optional snake_case **`meeting_id`** mirror; legacy field name `internalMeetingId` removed from webhook JSON.

When meeting reaches `completed`, `PostMeetingProcessor` emits additional event:
- `meeting.post_processing.completed`

## Strict Webhook Contract

When `JOBAI_WEBHOOK_ENABLED=true`:
- `JOBAI_WEBHOOK_URL` and `JOBAI_WEBHOOK_SECRET` are required
- headers sent:
  - `X-Webhook-Timestamp`
  - `X-Webhook-Signature` (`sha256=<hmac>`, signed as `<timestamp>.<jsonBody>`)
  - `X-Idempotency-Key`
- retry policy:
  - 2xx => delivered
  - 4xx (except 429) => terminal failure
  - 429/5xx/network => retry with exponential backoff (1s, 3s, 10s, 30s)

## Local Run

1. Install dependencies:

```bash
npm install
```

2. Create env:

```bash
cp .env.example .env
```

3. Set `OPENAI_API_KEY` in `.env`.

4. Start dev server:

```bash
npm run dev
```

5. Generate valid test SDP offer:

```bash
npm run generate:offer
```

6. Build + run production mode:

```bash
npm run build
npm run start
```

## Smoke Tests

Health:

```bash
curl -i http://localhost:8080/health
```

Ephemeral token:

```bash
curl -i http://localhost:8080/realtime/token
```

Session SDP offer/answer:

```bash
curl -i \
  -X POST http://localhost:8080/realtime/session \
  -H "Content-Type: application/sdp" \
  --data-binary "@offer.sdp"
```

DataChannel event ingestion:

```bash
curl -i \
  -X POST "http://localhost:8080/realtime/session/<session-id>/events" \
  -H "Content-Type: application/json" \
  -d '{"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}'
```

Meeting start:

```bash
curl -i \
  -X POST "http://localhost:8080/meetings/start" \
  -H "Content-Type: application/json" \
  -d '{"meetingId":"meeting-001","metadata":{"candidateId":"cand-1"}}'
```

Meeting fail:

```bash
curl -i \
  -X POST "http://localhost:8080/meetings/meeting-001/fail" \
  -H "Content-Type: application/json" \
  -d '{"status":"failed_connect_ws_audio","reason":"audio gateway unavailable"}'
```

Meeting stop/completed:

```bash
curl -i \
  -X POST "http://localhost:8080/meetings/meeting-001/stop" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual_stop","finalStatus":"completed"}'
```

Meeting state:

```bash
curl -i "http://localhost:8080/meetings/meeting-001"
```

Webhook queue stats:

```bash
curl -i "http://localhost:8080/ops/webhooks"
```

## HR Stream agent (Phase 5 — без EchoMimic worker)

Чтобы в Stream появился участник `agent_<sessionId>` с **video+audio** (и HR-плитка перестала показывать `agentFound: false`), на gateway нужны ключи Stream и включённый аватар-пайплайн:

- `AVATAR_ENABLED=1`
- `AVATAR_VIDEO_ENABLED=1`
- `VIDEO_MODEL=behavior_static` — публикует I420 через [`StreamAgentPublisher`](./src/services/streamAgentPublisher.ts) без RunPod EchoMimic; при `A2F_RUNTIME_ENABLED` рот модулируется по последнему кадру A2F.
- `STREAM_API_KEY`, `STREAM_API_SECRET`

Полный cinematic путь по-прежнему: `VIDEO_MODEL=echomimic` + `RUNPOD_WORKER_URL` и т.д.

## Phase 5A — EchoMimic realtime (8889) + Luna

Низколатентный нейро-рендер: gateway открывает WebSocket на воркер **8889**, шлёт `ingest` (PCM16 + опционально A2F), получает `frame` (I420) и публикует в Stream. Контракт: [`docs/ECHOMIMIC-8889-REALTIME-WIRE.md`](./docs/ECHOMIMIC-8889-REALTIME-WIRE.md).

**Env (gateway / DigitalOcean `systemd` drop-in или `.env`):**

| Переменная | Назначение |
|------------|------------|
| `VIDEO_MODEL=echomimic_realtime` | Включить realtime-пайплайн |
| `RUNPOD_ECHOMIMIC_REALTIME_URL` | База `https://…-8889.proxy.runpod.net` |
| `RUNPOD_ECHOMIMIC_REALTIME_BEARER` | Опционально: Bearer для HTTP/WS |
| `LUNA_REF_IMAGE_PATH` | Путь ref на GPU (default `/workspace/test_assets/luna.jpg`) |
| `STREAM_API_KEY`, `STREAM_API_SECRET` | Как для `behavior_static` |
| `A2F_GPU_RUNTIME_WS_URL` + `A2F_RUNTIME_TRANSPORT=gpu_pod` | Опционально: мультиплекс A2F в ingest |

**Smoke на дроплете:**

```bash
curl -sS http://127.0.0.1:8080/avatar/health
```

В JSON смотрите `echomimicRealtimeReachable` и `echomimicRealtimeLatencyMs` (проба `/realtime/v1/health` или `/health` на 8889).

## Docker

Build:

```bash
docker build -t realtime-webrtc-gateway .
```

Run:

```bash
docker run --rm -p 8080:8080 --env-file .env realtime-webrtc-gateway
```

## Storage Backends

By default sessions, meetings, and interview projections live in memory (lost on restart). To enable Redis persistence:

```
STORAGE_BACKEND=redis
REDIS_URL=redis://127.0.0.1:6379/0
# optional:
REDIS_PREFIX=nullxes:hr-ai
REDIS_SESSION_TTL_MS=86400000
REDIS_RECONNECT_MAX_DELAY_MS=30000
REDIS_HEARTBEAT_MS=15000
```

Per-key writes (`<prefix>:session:<id>`, `<prefix>:meeting:<id>`, `<prefix>:interview:<jobAiId>`) and on-startup `SCAN` for hydration. Legacy blob keys (`<prefix>:sessions`, `<prefix>:meetings`, `<prefix>:interviews`) are migrated to per-key on first start and then deleted (idempotent).

The Redis client (`src/services/redisClient.ts`) is a minimal RESP implementation on `node:net` with auto-reconnect (200ms→30s + jitter), heartbeat PING (15s), and a bounded command queue (default 100). No external Redis driver dependency.

## Observability

- `/metrics` exposes Prometheus metrics (`gateway_http_requests_total`, `gateway_http_request_duration_seconds`, `gateway_realtime_sessions_active`, `gateway_webhook_outbox_pending`, `gateway_webhook_outbox_failed`, `gateway_redis_reconnects_total`, plus default node metrics).
- `/health/ready` checks Redis connectivity (when enabled) and OpenAI key presence.

## Rate limiting and CORS

In-memory `express-rate-limit` (per IP, `trust proxy = 1` so X-Forwarded-For is honored):

- `POST /realtime/session` — 30 / min
- `GET  /realtime/token`  — 60 / min
- `POST /meetings/:id/admission/candidate/*` — 60 / min
- `POST /jobai/*` and `POST /webhooks/jobai*` — 120 / min

Configure with `RATE_LIMIT_ENABLED=false` to disable. CORS allowlist via `CORS_ALLOWED_ORIGINS` (comma-separated).

## Upgrading from v1 (memory-only) to v2 (admission + redis + tier1/2/3)

See [`UPGRADE-NOTES.md`](./UPGRADE-NOTES.md) for the deploy playbook and rollback procedure.

## Horizontal Scaling Notes

- With `STORAGE_BACKEND=redis` the session, meeting, and interview projection state survive restart and can be read by multiple replicas (per-key reads/writes; webhook outbox is still in-memory per replica).
- Use load-balancer stickiness if required by signaling/event patterns.
