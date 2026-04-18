# UI Contract: Details, References, Links

Этот контракт фиксирует, какие поля UI использует для блоков **Детали**, **Справочно**, **Ссылка кандидата**, **Ссылка наблюдателя** и стартового контекста AI-агента.

## Источник данных

- Список: `GET /interviews?skip&take&sync`
- Деталь: `GET /interviews/{id}`
- Webhook ingest: `POST /webhooks/jobai/interviews`

## Поля для таблицы и ссылок

Из `projection`:

- `jobAiId`
- `candidateFirstName`
- `candidateLastName`
- `companyName`
- `meetingAt`
- `jobAiStatus`
- `nullxesBusinessLabel`
- `candidateEntryPath` (UI кнопка «Ссылка кандидата»)
- `spectatorEntryPath` (UI кнопка «Ссылка наблюдателя»)

Webhook-ответ дополнительно отдает:

- `candidateUrl` (relative path)
- `spectatorUrl` (relative path)

## Поля для модалки «Справочно»

Из `interview`:

- `vacancyText`
- `specialty.questions[]` (`order`, `text`)
- `greetingSpeech` / `greetingSpeechResolved`
- `finalSpeech` / `finalSpeechResolved`

## Контекст старта AI-агента/аватара

На старте сессии в `startMeeting.metadata.interviewContext` передается:

- `candidateFirstName`
- `candidateLastName`
- `candidateFullName`
- `jobTitle`
- `vacancyText`
- `companyName`
- `greetingSpeech`
- `finalSpeech`
- `questions[]`

Это исключает необходимость агенту собирать контекст из разных источников во время вызова.
