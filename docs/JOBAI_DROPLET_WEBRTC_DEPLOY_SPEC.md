# JobAI Droplet Deployment Spec (WebRTC Gateway)

## 1) Цель документа

Этот документ описывает полный план развертывания `backend/realtime-gateway` на дроплете JobAI:

- как подготовить сервер;
- как развернуть код и окружение;
- как поднять `systemd` сервис;
- как проверить работоспособность WebRTC gateway;
- как безопасно обновлять и откатывать релизы.

Документ рассчитан на Ubuntu 22.04 LTS, `root`/`sudo` доступ и GitHub-репозиторий backend.

---

## 2) Архитектура развертки

- Runtime: Node.js service (`dist/index.js`) под `systemd`.
- Port приложения: `8080`.
- Хранилище: `memory` или `redis` (рекомендуется `redis` для персистентности state).
- Входящий трафик:
  - напрямую на `:8080` (только для внутренних/временных стендов),
  - или через reverse proxy (Nginx/Caddy) + TLS.
- Интеграции:
  - OpenAI Realtime API,
  - JobAI REST API (`/ai-api/...`),
  - JobAI ingest webhook (`POST /webhooks/jobai/interviews`).

---

## 3) Предварительные требования

## 3.1 Сервер

- Ubuntu 22.04.x LTS
- минимум: 2 vCPU / 4 GB RAM / 40+ GB disk
- открытые порты:
  - `22/tcp` (SSH),
  - `8080/tcp` (если без proxy),
  - `80/443` (если с Nginx/Caddy).

## 3.2 ПО

- `git`
- `curl`
- Node.js 20.x + npm
- `build-essential` (для зависимостей с native modules)
- `systemd` (стандартно есть)
- `redis-server` (опционально, но рекомендовано)

Установка:

```bash
sudo apt update
sudo apt install -y git curl build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

---

## 4) Структура директорий на дроплете

Рекомендуемая:

```text
/root/NULLXES_HR_BACKEND
  ├─ src/
  ├─ dist/
  ├─ package.json
  ├─ package-lock.json
  ├─ .env
  └─ ...
```

Логи:

- `journalctl -u nullxes-hr-backend`
- (опционально) отдельный лог-файл через proxy/rsyslog.

---

## 5) Переменные окружения

Минимально обязательные:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL=https://api.openai.com/v1`
- `OPENAI_REALTIME_MODEL=gpt-realtime`
- `OPENAI_REALTIME_VOICE=<voice>`
- `JOBAI_API_BASE_URL=<https://...>`
- `JOBAI_API_AUTH_MODE=<bearer|basic|none>`
- `JOBAI_API_TOKEN` (если bearer)
- `JOBAI_INGEST_SECRET` (если защищаем ingest webhook)

Рекомендуемые:

- `PORT=8080`
- `NODE_ENV=production`
- `STORAGE_BACKEND=redis`
- `REDIS_URL=redis://127.0.0.1:6379/0`
- `CORS_ALLOWED_ORIGINS=...`

Важно:

- `.env` не коммитим;
- ротация ключей проводится через обновление `.env` + `systemctl restart`.

---

## 6) Первый деплой (bootstrap)

## 6.1 Клонирование и установка зависимостей

```bash
cd /root
git clone https://github.com/MagistrTheOne/NULLXES_HR_BACKEND.git
cd /root/NULLXES_HR_BACKEND
npm ci
```

## 6.2 Подготовка `.env`

```bash
cp .env.example .env
nano .env
```

Заполнить все требуемые значения (см. раздел 5).

## 6.3 Сборка

```bash
npm run build
```

---

## 7) Systemd service

Создать unit:

```bash
sudo tee /etc/systemd/system/nullxes-hr-backend.service > /dev/null <<'EOF'
[Unit]
Description=NULLXES HR Backend - Realtime WebRTC Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/NULLXES_HR_BACKEND
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /root/NULLXES_HR_BACKEND/dist/index.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF
```

Применить:

```bash
sudo systemctl daemon-reload
sudo systemctl enable nullxes-hr-backend
sudo systemctl start nullxes-hr-backend
sudo systemctl status nullxes-hr-backend -l --no-pager -n 80
```

---

## 8) Smoke checks после запуска

## 8.1 Базовые health/endpoints

```bash
curl -i http://127.0.0.1:8080/health
curl -i http://127.0.0.1:8080/health/ready
curl -s -o /dev/null -w "realtime_session_status=%{http_code}\n" http://127.0.0.1:8080/realtime/session/test-404
```

Ожидаемо:

- `/health` -> `200`
- `/health/ready` -> `200` (или `503`, если реально не готов Redis/OpenAI key)
- `test-404` -> `404` (это нормальный ответ для несуществующей сессии)

## 8.2 Проверка конфигурации realtime-клиента

```bash
sudo journalctl -u nullxes-hr-backend -n 120 --no-pager | grep -i "openai realtime client configured" | tail -1
```

Проверяем, что `model` и `voice` соответствуют ожиданию.

---

## 9) Стандартный релизный апдейт

Один проход:

```bash
cd /root/NULLXES_HR_BACKEND && git pull --ff-only origin main && npm ci && npm run build && sudo systemctl restart nullxes-hr-backend && sudo systemctl status nullxes-hr-backend -l --no-pager -n 80
```

Быстрая post-check команда:

```bash
curl -s -o /dev/null -w "realtime_session_status=%{http_code}\n" http://127.0.0.1:8080/realtime/session/test-404
```

---

## 10) Частые инциденты и диагностика

## 10.1 `EADDRINUSE :8080`

Симптом: сервис падает при старте, порт занят сторонним процессом.

```bash
sudo ss -ltnp | grep ':8080'
ps -ef | grep -E 'node .*dist/index.js' | grep -v grep
```

Быстрое лечение:

```bash
sudo systemctl stop nullxes-hr-backend
sudo fuser -k 8080/tcp 2>/dev/null || true
sudo systemctl reset-failed nullxes-hr-backend
sudo systemctl start nullxes-hr-backend
```

## 10.2 Неверные ключи / auth ошибки

Проверить:

- `.env` значения (`JOBAI_*`, `OPENAI_*`)
- `journalctl` ошибки 401/403/5xx
- доступность внешних URL из дроплета.

## 10.3 Сервис “active”, но endpoint не отвечает

```bash
sudo journalctl -u nullxes-hr-backend -n 200 --no-pager
curl -i http://127.0.0.1:8080/health
```

---

## 11) Rollback strategy

## 11.1 Откат к предыдущему коммиту

```bash
cd /root/NULLXES_HR_BACKEND
git log --oneline -n 10
git checkout <previous_commit_sha>
npm ci
npm run build
sudo systemctl restart nullxes-hr-backend
```

После стабилизации:

- создать hotfix branch или вернуть `main` на корректный коммит в Git (по процессу команды).

## 11.2 Конфигурационный rollback

- восстановить рабочий `.env` из backup;
- `sudo systemctl restart nullxes-hr-backend`.

---

## 12) Рекомендации по эксплуатации

- Всегда использовать `git pull --ff-only` на проде.
- После каждого релиза выполнять smoke-check (`health`, `test-404`, realtime config log).
- Держать минимум один backup `.env` вне репозитория.
- Не запускать параллельно “watchdog/tmux loop” и `systemd` для одного и того же `dist/index.js`.
- Для стабильности state на рестартах включить `STORAGE_BACKEND=redis`.

---

## 13) Runbook short version (для дежурного)

Рестарт:

```bash
sudo systemctl restart nullxes-hr-backend && sudo systemctl status nullxes-hr-backend -l --no-pager -n 80
```

Логи:

```bash
sudo journalctl -u nullxes-hr-backend -f
```

Быстрый health:

```bash
curl -i http://127.0.0.1:8080/health
curl -s -o /dev/null -w "realtime_session_status=%{http_code}\n" http://127.0.0.1:8080/realtime/session/test-404
```

---

## 14) Full bootstrap command (template)

Ниже шаблон полного bootstrap: **подставьте реальные секреты на сервере** (никогда не коммитьте их в Git). Значения вроде URL фронта, JobAI base URL и флагов — пример структуры.

```bash
cd /root && \
[ -d /root/NULLXES_HR_BACKEND ] || git clone https://github.com/MagistrTheOne/NULLXES_HR_BACKEND.git /root/NULLXES_HR_BACKEND && \
cd /root/NULLXES_HR_BACKEND && \
cat > .env <<'EOF'
NODE_ENV=production
PORT=8080
OPENAI_API_KEY="<YOUR_OPENAI_API_KEY>"
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_REALTIME_MODEL=gpt-realtime
OPENAI_REALTIME_VOICE=marin
OPENAI_HTTP_TIMEOUT_MS=20000
SESSION_IDLE_TIMEOUT_MS=300000
SESSION_SWEEP_INTERVAL_MS=30000
SDP_MAX_BYTES=200000
JOBAI_API_BASE_URL=https://back.example.job-ai.ru
JOBAI_API_AUTH_MODE=bearer
JOBAI_API_TOKEN="<YOUR_JOBAI_API_JWT>"
JOBAI_INGEST_SECRET="<YOUR_JOBAI_INGEST_SECRET_HEX>"
STORAGE_BACKEND=redis
REDIS_URL=redis://127.0.0.1:6379/0
REDIS_PREFIX=nullxes:hr-ai
REDIS_SESSION_TTL_MS=86400000
CORS_ALLOWED_ORIGINS=https://your-frontend.example.com
JOIN_TOKEN_SECRET="<RANDOM_LONG_SECRET>"
JOIN_TOKEN_DEFAULT_TTL_MS=86400000
JOIN_TOKEN_FRONTEND_BASE_URL=https://your-frontend.example.com
GATEWAY_SHARED_TOKEN="<RANDOM_LONG_SHARED_TOKEN>"
AVATAR_POD_URL=https://your-avatar-pod.example
AVATAR_SHARED_TOKEN="<MATCH_OR_SEPARATE_AVATAR_TOKEN>"
AVATAR_ENABLED=true
AVATAR_DEFAULT_KEY=anna
AVATAR_DEFAULT_EMOTION=neutral
STREAM_API_KEY="<YOUR_STREAM_API_KEY>"
STREAM_API_SECRET="<YOUR_STREAM_API_SECRET>"
STREAM_BASE_URL=https://video.stream-io-api.com
STREAM_CALL_TYPE=default
AVATAR_REFERENCE_IMAGE_URL=https://example.com/avatar-reference.jpg
OPENAI_TURN_DETECTION_TYPE=server_vad
OPENAI_TURN_DETECTION_THRESHOLD=0.72
OPENAI_TURN_DETECTION_PREFIX_PADDING_MS=450
OPENAI_TURN_DETECTION_SILENCE_DURATION_MS=900
REDIS_RECONNECT_MAX_DELAY_MS=30000
REDIS_HEARTBEAT_MS=15000
REDIS_COMMAND_QUEUE_LIMIT=100
METRICS_ENABLED=true
RATE_LIMIT_ENABLED=true
RATE_LIMIT_TRUST_PROXY=true
CANDIDATE_ADMISSION_REJOIN_WINDOW_MS=60000
JOIN_TOKEN_AUDIT_LIMIT=100
AVATAR_HTTP_TIMEOUT_MS=15000
EOF

npm ci && npm run build && \
sudo systemctl restart nullxes-hr-backend && \
sudo systemctl status nullxes-hr-backend -l --no-pager -n 80 && \
curl -i http://127.0.0.1:8080/health && \
curl -s -o /dev/null -w "realtime_session_status=%{http_code}\n" http://127.0.0.1:8080/realtime/session/test-404
```

