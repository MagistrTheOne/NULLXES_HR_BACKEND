<!-- BEGIN:nullxes-backend-agent-notes -->
# NULLXES / HR AI — Realtime Gateway agent notes

**Субтри:** `backend/realtime-gateway/` → remote `backend` (отдельный GitHub-репо).
**Стек:** Node 20+, TypeScript, Express, pino, ioredis (опционально), OpenAI Realtime API.

---

## Что это

TypeScript-оркестратор, который:

1. Минтит Stream-токены (HR/candidate/observer/avatar-viewer) через `streamCallTokenService`.
2. Поднимает OpenAI Realtime call (`POST /v1/realtime/calls`) через `openaiRealtimeClient` — возвращает SDP-answer для WebRTC.
3. Провижинит avatar pod через `avatarClient` → RunPod / локальный avatar-service.
4. Держит `SessionStore` (in-memory или Redis) — статус сессий, idle-sweeper, history, webhooks.
5. Принимает callback'и от avatar pod (`/avatar/events`) и от meeting-орчестратора.

---

## Карта файлов

### Config
| Файл | За что отвечает |
|---|---|
| `src/config/env.ts` | zod-валидация ENV. Дефолты таймаутов. |

Ключевые переменные:
```
OPENAI_API_KEY
OPENAI_HTTP_TIMEOUT_MS=20000
SESSION_IDLE_TIMEOUT_MS=300000      # 5 min (поднят с 120k)
SESSION_SWEEP_INTERVAL_MS
REDIS_URL / REDIS_HEARTBEAT_MS=15000
AVATAR_HTTP_TIMEOUT_MS=15000
AVATAR_SERVICE_BASE_URL
AVATAR_SERVICE_API_KEY
STREAM_API_KEY / STREAM_API_SECRET
```

### Services
| Файл | За что отвечает |
|---|---|
| `src/services/openaiRealtimeClient.ts` | `POST /v1/realtime/calls` multipart (SDP offer + session). `fetchWithTimeout`. **VAD-тюнинг жить должен здесь, в multipart `session`.** |
| `src/services/avatarClient.ts` | HTTP к avatar pod (`createSession`, `warmup`, health). `AVATAR_HTTP_TIMEOUT_MS`. |
| `src/services/streamCallTokenService.ts` | Stream JWT для pod viewer. |
| `src/services/meetingOrchestrator.ts` | `startMeeting(ctx)` — полный цикл: Stream user, Stream call, OpenAI call, avatar pod. |
| `src/services/sessionStore.ts` | In-memory sessions + sweeper. |
| `src/services/persistedSessionStore.ts` | Redis-backed версия. |
| `src/services/storageFactory.ts` | Выбор in-memory / redis по ENV. |
| `src/services/redisClient.ts` | ioredis wrapper + reconnect. |
| `src/services/webhookDispatcher.ts` | Async post webhook events. |
| `src/services/postMeetingProcessor.ts` | Фоновая обработка после закрытия сессии. |

### Routes
| Файл | Роуты |
|---|---|
| `src/routes/sessions.routes.ts` | `POST /sessions` (create), `DELETE /sessions/:id` (stop), `GET /sessions/:id`. |
| `src/routes/interviews.routes.ts` | `GET /interviews/:id` — детали из HR-системы (jobAI backend). |
| `src/routes/avatar.routes.ts` | `POST /avatar/events` — callbacks от pod (`first_frame`, `session_ready`, `error`). |
| `src/routes/stream.routes.ts` | Stream-token endpoints. |

### App
- `src/index.ts` — bootstrap, listen.
- `src/app.ts` — Express app, middleware, router mount.
- `src/middleware/` — auth, CORS, rate-limit, request-id, error handler.
- `src/logging/` — pino logger + serializers.

---

## Последнее состояние

**HEAD:** `2afdc74 feat(avatar): provision Stream user + call before pod kickoff`.

Что сделано недавно:
- `avatarClient.ts` — HTTP клиент к avatar pod, управление таймаутами, создание сессии.
- `meetingOrchestrator.ts` — провижинит Stream user + call ДО kickoff'а pod, чтобы pod сразу мог опубликовать. Избежали race между pod.publish и call.create.
- `env.ts` — добавлены `AVATAR_*` и `STREAM_*` vars.
- `avatar.routes.ts` — callbacks endpoint.

---

## Gotchas

1. **`SESSION_IDLE_TIMEOUT_MS=300000`** — адаптивный интервьюер делает паузы 30–90s. Раньше было 120k — иногда рубило живые сессии. НЕ понижай обратно.

2. **OpenAI Realtime multipart** — `POST /v1/realtime/calls` принимает SDP offer + `session` JSON как multipart. Туда кладём `turn_detection` / `voice` / `input_audio_format` / `instructions`. **Runtime `session.update` с turn_detection — GA endpoint реджектит.** Все VAD-настройки — только в этом multipart.

3. **Avatar pod kickoff последовательность**:
   ```
   Stream user (HR/candidate) → Stream call.create
   → OpenAI Realtime call (SDP exchange)
   → avatar pod.createSession (с sessionId + stream viewer-token)
   → pod publishes agent_<sessionId> video track в Stream call
   ```
   Любое изменение порядка ломает либо pod (нечего джойнить), либо HR-viewer (нет аватара).

4. **Frontend ↔ gateway путь** — `/api/gateway/[...path]/route.ts` в Next.js проксирует с `AbortSignal.timeout(60_000)`. Если добавляешь новый slow endpoint — проверь что 60с хватает.

5. **`timeout of 5000ms exceeded` — НЕ ЗДЕСЬ.** Этот текст приходит из axios внутри Stream SDK на frontend. Backend таймауты у нас ≥ 15000мс.

6. **Redis optional** — in-memory работает для single-instance deploy. Horizontal scale → Redis обязателен, иначе sessionStore десинхронится.

---

## Pending

- **VAD-тюнинг в `openaiRealtimeClient.createCall`** — добавить в multipart `session` параметры `turn_detection.threshold`, `prefix_padding_ms`, `silence_duration_ms` для шумоустойчивости. Сейчас используются дефолты.
- **Webhook retries** — `webhookDispatcher` делает 1 попытку. Нужна exponential back-off очередь (BullMQ?) для гарантированной доставки.
- **Observer SFU scope** — проверить что `streamCallTokenService` выдаёт observer-токен с правильным read-only scope (для `/spectator`).

---

## Команды

```powershell
cd backend/realtime-gateway
npm install
npm run dev          # watch mode
npm run build        # dist/
npm test             # pino tests
npx tsc --noEmit 2>&1 | Select-Object -Last 30

# subtree push (из корня monorepo)
git subtree push --prefix=backend/realtime-gateway backend main
```

---

## Smoke-тест работоспособности (ручной)

1. `curl -X POST http://localhost:3000/stream/token -d '{"role":"candidate","meetingId":"m-1","userId":"cand-1"}'` → JWT.
2. `curl -X POST http://localhost:3000/sessions -d '{...ctx...}'` → должен вернуть `sessionId`, `callId`, `peerSdpAnswer`.
3. `GET /sessions/<id>` → status = `active`.
4. Через `SESSION_IDLE_TIMEOUT_MS` без активности → sweeper закроет, status = `closed`.
<!-- END:nullxes-backend-agent-notes -->
