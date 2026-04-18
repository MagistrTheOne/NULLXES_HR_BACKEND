# Что выдать Nullxes (realtime-gateway): доступ к JobAI API

Этот файл можно переслать команде **JobAI / DevOps / бэкенд JobAI**. Наш сервис читает переменные из **одного** `.env` рядом с `realtime-gateway` (см. `.env.example`).

## Что нужно от вас (минимум)

1. **Базовый URL** публичного API (как в Swagger), **без** завершающего слэша.  
   Пример: `https://back.dev.job-ai.ru`  
   → мы кладём в **`JOBAI_API_BASE_URL`**.

2. **Способ авторизации** к защищённым маршрутам `/ai-api/...` (роли `admin`, `ai_assistant` и т.д. — как у вас в Swagger):

   | Вариант | Что выдать | Что мы ставим в `.env` |
   |--------|------------|-------------------------|
   | **Bearer** (JWT или API token в заголовке) | Одна строка токена | `JOBAI_API_AUTH_MODE=bearer` и `JOBAI_API_TOKEN=<токен>` |
   | **Basic** | Логин + пароль (сервисная учётка только для интеграции) | `JOBAI_API_AUTH_MODE=basic`, `JOBAI_API_BASIC_USER=...`, `JOBAI_API_BASIC_PASSWORD=...` |
   | **Публично не нужно** (редко для прода) | Подтверждение, что список/деталь доступны без auth | `JOBAI_API_AUTH_MODE=none` (только если реально так) |

3. **Окружение**: явно напишите, это **dev / stage / prod** и совпадает ли URL с тем, куда мы будем слать запросы.

## Как мы ходим в API (для проверки у себя)

- `GET {JOBAI_API_BASE_URL}/ai-api/interviews?skip=0&take=20` — список  
- `GET {JOBAI_API_BASE_URL}/ai-api/interviews/{id}` — карточка  
- `POST {JOBAI_API_BASE_URL}/ai-api/interviews/{id}/status` — смена статуса (тело `{"status":"..."}`)

Авторизация с нашей стороны:

- **bearer**: заголовок `Authorization: Bearer <JOBAI_API_TOKEN>`  
- **basic**: заголовок `Authorization: Basic base64(user:password)`

## Что сделать, чтобы «не тупило»

- Выдать **одну** схему (либо bearer, либо basic), не смешивать.  
- **Bearer**: токен без пробелов и переносов; срок жизни — либо долгий сервисный, либо процесс продления + контакт, куда писать при 401.  
- **Basic**: отдельная учётка **только для интеграции**, не личная почта сотрудника; пароль меняется у вас по процессу — мы обновим `.env`.  
- **Base URL**: строго тот хост, где реально отвечает Swagger (без опечаток, без лишнего `/ai-api` в конце `BASE_URL` — суффикс `/ai-api/...` мы дописываем сами).  
- Если у вас **IP allowlist** или WAF — заранее добавить **исходящий IP** сервера, где крутится gateway (или egress NAT).

## Webhook на наш gateway (отдельно от REST)

Если вы **шлёте** payload собеседования на наш URL `POST /webhooks/jobai/interviews`:

- Договоритесь с нами о **`JOBAI_INGEST_SECRET`** (мы задаём у себя в `.env` то же значение).  
- Вы передаёте секрет в **`Authorization: Bearer <secret>`** или **`x-jobai-ingest-secret: <secret>`** (как договоримся).

Это **не** заменяет REST-ключи выше: REST — мы тянем к вам; webhook — вы пушите к нам.

## Быстрая самопроверка (curl для вашей стороны)

Подставьте свой URL и токен:

```bash
curl -sS -H "Authorization: Bearer YOUR_TOKEN" \
  "https://YOUR_HOST/ai-api/interviews?skip=0&take=5"
```

Ожидаем **HTTP 200** и JSON со списком. Если **401/403** — роль или токен не подходят для этих путей.

## Куда мы кладём значения

Файл **`backend/realtime-gateway/.env`** (не коммитится в git). Шаблон: **`backend/realtime-gateway/.env.example`**.

После изменения `.env` gateway нужно **перезапустить**.
