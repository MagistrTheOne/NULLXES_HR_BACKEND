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
- `POST /meetings/:meetingId/stop`
  - Stops meeting with terminal state: `stopped_during_meeting` or `completed`.
- `POST /meetings/:meetingId/fail`
  - Marks meeting as `failed_audio_pool_busy` or `failed_connect_ws_audio`.
- `GET /meetings/:meetingId`
  - Returns current meeting state with transition history.
- `GET /meetings`
  - Returns all meeting records.
- `GET /ops/webhooks`
  - Returns in-memory webhook queue stats.

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
- produces webhook outbox event `meeting.status.changed`

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
  -d '{"internalMeetingId":"meeting-001","triggerSource":"scheduler","metadata":{"candidateId":"cand-1"}}'
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

## Docker

Build:

```bash
docker build -t realtime-webrtc-gateway .
```

Run:

```bash
docker run --rm -p 8080:8080 --env-file .env realtime-webrtc-gateway
```

## Horizontal Scaling Notes

- Current store is in-memory and suitable for single-instance deployments.
- For multi-instance:
  - Implement Redis/PostgreSQL-backed adapters for session, meeting state, outbox, and idempotency.
  - Ensure meeting/event state is shared across replicas.
  - Use load-balancer stickiness if required by signaling/event patterns.
