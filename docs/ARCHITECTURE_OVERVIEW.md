# Nullxes AI Interview Platform - Architecture Overview

## 1. Goal

Build a browser-based interview prototype centered around:
- Nullxes AI realtime interview runtime
- JobAI as the source of interview data
- Interview list/table operations and role-based entry links
- Candidate/spectator media flow validation
- Avatar question execution pipeline

Zoom-specific integration is explicitly out of scope for this version.

## 2. System Context

```mermaid
flowchart LR
  jobai[JobAI Backend]
  nullxes[Nullxes Interview Platform]
  candidate[Candidate Browser]
  spectator[Spectator Browser]
  admin[Admin Browser]
  oai[OpenAI Realtime]

  jobai -->|Webhook + GET interviews| nullxes
  admin -->|Interview table + controls| nullxes
  candidate -->|Join link + media| nullxes
  spectator -->|Join link + media| nullxes
  nullxes -->|SDP + token + events| oai
  nullxes -->|Status updates webhook| jobai
```

## 3. Logical Components

### 3.1 API Gateway Layer
- Exposes all HTTP endpoints for:
  - Realtime session and token
  - Meeting orchestration
  - Interview ingestion/sync (JobAI)
  - Interview table queries and details
- Applies basic auth for prototype access.

### 3.2 Interview Domain Service
- Stores interview objects from JobAI as-is (raw payload) and normalized projection for UI table.
- Maintains statuses in two dimensions:
  - `nullxes_status` (internal lifecycle)
  - `jobai_status` (external source-of-truth mirror)

### 3.3 Meeting Orchestrator
- Runs meeting lifecycle:
  - `pending -> starting -> in_meeting -> completed|failed_*|stopped_during_meeting`
- Emits transition events for webhook and internal observability.

### 3.4 Realtime Runtime
- Handles:
  - `POST /realtime/session` (SDP offer/answer gateway)
  - `GET /realtime/token`
  - DataChannel event ingestion/normalization
- Feeds avatar runtime with questions and interview script fragments.

### 3.5 Webhook Delivery Pipeline
- Outbox-based strict delivery to JobAI.
- HMAC signature + idempotency key + retry with backoff.
- Delivery state tracking: pending / delivered / terminal_failed.

### 3.6 Session/Media Coordination
- Candidate and spectator join via signed links.
- Runtime tracks participant role, session binding, and media state checkpoints.
- Video/media checks are runtime validation points, not Zoom implementation.

## 4. Data Model (High-Level)

## 4.1 Interview Aggregate
- `nullxes_id` (internal UUID)
- `jobai_id` (external numeric/string id)
- candidate fields: first/last name (separate, no merge)
- `company_name`
- `meeting_at`
- `nullxes_status`
- `jobai_status`
- `candidate_join_token`
- `spectator_join_token`
- `raw_payload_json` (full JobAI interview payload 1:1)

### 4.2 Meeting Aggregate
- `meeting_id` (equals or links to interview id context)
- `status`
- `trigger_source`
- `session_id` (if bound to realtime session)
- transition history with reason/timestamp

### 4.3 Webhook Delivery Aggregate
- `idempotency_key`
- `event_type`
- `attempt_count`
- `next_attempt_at`
- `last_error`
- `delivery_status`

## 5. Key Flows

## 5.1 JobAI -> Nullxes Interview Ingestion
```mermaid
sequenceDiagram
  participant J as JobAI
  participant N as Nullxes API
  participant S as Storage

  J->>N: webhook (interview id/event)
  N->>J: GET /ai-api/interviews/{id}
  J-->>N: interview payload
  N->>S: save raw payload 1:1
  N->>S: update table projection
```

## 5.2 Admin Table View
```mermaid
sequenceDiagram
  participant A as Admin UI
  participant N as Nullxes API
  participant S as Storage

  A->>N: GET interviews list
  N->>S: query projection
  S-->>N: rows
  N-->>A: table payload
```

## 5.3 Meeting Start + Realtime Binding
```mermaid
sequenceDiagram
  participant U as User Client
  participant N as Nullxes API
  participant O as OpenAI Realtime

  U->>N: POST /meetings/start
  N->>N: transition pending->starting->in_meeting
  U->>N: POST /realtime/session (SDP offer)
  N->>O: POST /v1/realtime/calls (application/sdp)
  O-->>N: SDP answer
  N-->>U: SDP answer + session id
```

## 5.4 Status Webhook to JobAI
```mermaid
sequenceDiagram
  participant N as Nullxes Orchestrator
  participant Q as Webhook Outbox
  participant D as Dispatcher
  participant J as JobAI

  N->>Q: enqueue status event
  D->>Q: pull ready item
  D->>J: POST webhook (HMAC + idempotency)
  alt success 2xx
    D->>Q: mark delivered
  else retryable 429/5xx/network
    D->>Q: schedule retry
  else terminal 4xx
    D->>Q: mark terminal_failed
  end
```

## 6. API Surface (Target)

### Existing core
- `GET /health`
- `GET /realtime/token`
- `POST /realtime/session`
- `POST /realtime/session/:sessionId/events`
- `POST /meetings/start`
- `POST /meetings/:meetingId/stop`
- `POST /meetings/:meetingId/fail`
- `GET /meetings/:meetingId`
- `GET /meetings`
- `GET /ops/webhooks`

### Required for interview prototype
- `POST /webhooks/jobai/interviews`
- `POST /sync/jobai/interviews/:id`
- `GET /interviews`
- `GET /interviews/:nullxesId`
- `POST /interviews/:nullxesId/links/candidate`
- `POST /interviews/:nullxesId/links/spectator`
- `GET /join/candidate/:token`
- `GET /join/spectator/:token`

## 7. Runtime/Deployment Topology (Prototype)

- Single Node.js service instance
- In-memory meeting/webhook stores (current)
- Persistent DB for interview list + payload (to be added in next phase)
- Basic Auth in front of UI/API

## 8. Non-Goals for this phase

- Zoom start/join lifecycle integration
- Production-grade multi-region HA
- Enterprise IAM/SSO

## 9. Deliverables for review

- Architecture doc (this file)
- Backlog with milestones and DoD
- API contract draft for interview ingestion/list/links
- Demo сценарии:
  - Interview sync from JobAI
  - Interview list rendering
  - Candidate/spectator link flow
  - Realtime avatar question playback
