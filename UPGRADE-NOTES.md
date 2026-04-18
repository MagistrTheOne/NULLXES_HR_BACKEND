# Realtime Gateway — Upgrade Notes (v2: candidate admission + redis storage + tier 1/2/3)

Эти заметки описывают деплой ветки `v2-redis-tiered` поверх существующего `main` без сноса `.env`.

## Что меняется

### Bug-fix: candidate admission

Фронт уже зовёт 4 эндпоинта, которые на `main` не реализованы (стабильные `404` или 503 fallback):

- `GET    /meetings/:id/admission/candidate?participantId=…`
- `POST   /meetings/:id/admission/candidate/acquire`
- `POST   /meetings/:id/admission/candidate/release`
- `POST   /meetings/:id/admission/candidate/decision`

Контракт строго совпадает с `frontend/jobaidemo/lib/api.ts` (`CandidateAdmissionStatus`, `CandidateAdmissionParticipant`, `CandidateAdmissionPending`).

Логика:

- слот занят `owner` или свободен; есть очередь `pending` (cap = 5);
- `acquire` теми же `participantId` — рефреш; свободно/просрочено (`lastSeenAt + REJOIN_WINDOW < now`) — auto-grant; иначе 423 + payload;
- `release` — снимает owner; если в pending кто-то есть, промоутит первого (per spec);
- `decision approve` — берёт из pending и ставит owner; `deny` — выбрасывает из pending (и evict, если уже owner).

### Storage Tier 3.1 — per-key Redis

Новые опции `.env`:

```
STORAGE_BACKEND=redis
REDIS_URL=redis://127.0.0.1:6379/0
# опционально:
REDIS_PREFIX=nullxes:hr-ai
REDIS_SESSION_TTL_MS=86400000
REDIS_RECONNECT_MAX_DELAY_MS=30000
REDIS_HEARTBEAT_MS=15000
REDIS_COMMAND_QUEUE_LIMIT=100
```

При `STORAGE_BACKEND=memory` (default) — поведение прежнее, Redis вообще не подключается. Это безопасный фолбэк для тех инсталляций, где Redis не установлен.

При `STORAGE_BACKEND=redis`:

- запись per-key (`nullxes:hr-ai:session:<id>`, `…:meeting:<id>`, `…:interview:<jobAiId>`), без переписывания блоба на каждое событие;
- TTL только на сессии (`REDIS_SESSION_TTL_MS`, default 24h);
- legacy миграция: при старте, если найден `${prefix}:sessions` / `${prefix}:meetings` / `${prefix}:interviews` (старый блоб) — раскладывается per-key и удаляется (идемпотентно);
- свой минимальный RESP-клиент (`src/services/redisClient.ts`) с auto-reconnect (200ms → 30s + 20% jitter), heartbeat PING каждые 15s, командной очередью (cap 100). Без зависимостей от ioredis/node-redis.

### Tier 1.1 — `GET /realtime/session/:id`

Эндпоинт уже был, но фронт логировал 404 — это был стейл-билд на дроплете. После раскатки этой ветки фронт получит `200 { session }` и SDK перестанет шуметь в консоли.

### Tier 1.2 — `/health/ready`

Новый эндпоинт. Возвращает `200` если openai key есть и (если включён redis) PING прошёл. Возвращает `503` если redis недоступен или нет ключа OpenAI. Тело:

```
{
  "uptimeSeconds": 12.3,
  "storageBackend": "redis",
  "openai": "ok",
  "redis": "ok",
  "redisReconnects": 0,
  "webhookOutbox": { "pending": 0, "delivered": 12, "terminalFailed": 0 }
}
```

### Tier 1.4 — sessions idle timeout

`SESSION_IDLE_TIMEOUT_MS` поднят с `120000` до `300000`. Адаптивный интервьюер делает паузы 30–90s, иногда дольше — старый порог иногда закрывал живые сессии.

### Tier 2.1 — `/metrics` (prom-client)

Эндпоинт `GET /metrics` (формат Prometheus). Метрики:

- `gateway_http_requests_total{method,route,status}`
- `gateway_http_request_duration_seconds{method,route,status}` (histogram)
- `gateway_realtime_sessions_active`
- `gateway_webhook_outbox_pending`, `gateway_webhook_outbox_failed`
- `gateway_redis_reconnects_total`
- `gateway_*` defaults (cpu, memory, gc, eventloop)

Выключить: `METRICS_ENABLED=false`.

### Tier 2.2 — rate-limit (in-memory)

`express-rate-limit` на горячие маршруты (per IP):

- `POST /realtime/session` — 30/min
- `GET  /realtime/token`  — 60/min
- `POST /meetings/:id/admission/candidate/*` — 60/min
- `POST /jobai/*` и `POST /webhooks/jobai*` — 120/min

Trust-proxy=1, чтобы IP читался из `X-Forwarded-For` за nginx. Выключить: `RATE_LIMIT_ENABLED=false`.

### Tier 2.3 — CORS allowlist

`CORS_ALLOWED_ORIGINS=https://hr.app.example.com,https://staging.hr.app.example.com`. По умолчанию `http://localhost:3000`. Используйте `*` чтобы вернуться к открытому CORS (не рекомендуется для prod).

### Tier 3.2 — pino redact

В `src/logging/logger.ts` расширены `redact.paths`: маскируются `OPENAI_API_KEY`, `JOBAI_*_TOKEN/SECRET/PASSWORD`, `REDIS_URL`, `Authorization`/`Cookie` хедеры, любые `*.token`/`*.secret`/`*.apiKey`/`*.password` в произвольной глубине логируемых объектов.

## Деплой на дроплет (без сноса .env)

```bash
APP_DIR=/root/NULLXES_HR_BACKEND
cd "$APP_DIR"

# 1. backup .env и dist
cp .env "/root/.env.nullxes-hr.bak.$(date +%Y%m%d-%H%M)"
cp -a dist "../NULLXES_HR_BACKEND.dist.bak.$(date +%Y%m%d-%H%M)"

# 2. забираем новую ветку (ничего не трогая в main)
git fetch origin v2-redis-tiered
git checkout v2-redis-tiered

# 3. (опционально) включаем Redis. Если хотите остаться на memory — пропустите этот шаг,
#    backend стартует как раньше.
if ! grep -q '^STORAGE_BACKEND=' .env; then
  echo "STORAGE_BACKEND=redis"            >> .env
  echo "REDIS_URL=redis://127.0.0.1:6379/0" >> .env
fi

# 4. сборка
npm ci
npm run typecheck
npm run build

# 5. рестарт
sudo systemctl restart nullxes-hr-backend
sleep 2
sudo systemctl status nullxes-hr-backend --no-pager -n 5

# 6. smoke
curl -sS http://127.0.0.1:8080/health
echo
curl -sS http://127.0.0.1:8080/health/ready
echo
curl -sSo /dev/null -w 'GET /metrics -> %{http_code}\n' http://127.0.0.1:8080/metrics
curl -sSo /dev/null -w 'GET /realtime/session/no-such -> %{http_code}\n' http://127.0.0.1:8080/realtime/session/no-such
curl -sSo /dev/null -w 'GET /meetings/no-such/admission/candidate?participantId=x -> %{http_code}\n' "http://127.0.0.1:8080/meetings/no-such/admission/candidate?participantId=x"
```

Ожидаемое:

- `/health` — 200, прежний JSON
- `/health/ready` — 200 если redis включён и доступен; 503 если redis включён но недоступен
- `/metrics` — 200 + текст в Prometheus exposition format
- `/realtime/session/no-such` — 404 (но JSON `{ "error":"NotFound", … }`, а не «Route not found»)
- `/meetings/no-such/admission/candidate?participantId=x` — 404 («Meeting not found»), но НЕ «Route not found»

## Rollback

```bash
cd /root/NULLXES_HR_BACKEND
git checkout main
npm ci
npm run build
sudo systemctl restart nullxes-hr-backend
```

`.env` не трогали — он переживает rollback автоматически. Старый блоб в Redis (если был) уже мигрирован в per-key — при rollback на `main` старый код снова перепишет блоб поверх per-key, потеряв новые сессии. Для full safety-net `cp .env .env.bak` и `redis-cli --rdb /root/redis.bak.rdb` перед апгрейдом.

## Что НЕ трогаем (явно)

- Контракт вебхуков `JOBAI_WEBHOOK_*` — не меняли.
- Секреты `.env` — не ротировали (Tier 0 пропущен по запросу).
- `main` ветка GitHub-репо — не пушим, всё уходит в `v2-redis-tiered`.
- Postgres / Zoom / OpenAI realtime контракт — без изменений.
