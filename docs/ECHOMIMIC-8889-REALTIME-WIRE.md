# EchoMimic 8889 — realtime wire protocol (frozen)

**Version:** 1.0 (Phase 5A)  
**Base URL:** `RUNPOD_ECHOMIMIC_REALTIME_URL` — e.g. `https://<pod>-8889.proxy.runpod.net` (no trailing slash).  
**Auth (optional):** `RUNPOD_ECHOMIMIC_REALTIME_BEARER` — if set, gateway sends `Authorization: Bearer <token>` on HTTP and `Sec-WebSocket-Protocol` is **not** used; bearer only on HTTP upgrade is not standard, so use **query** `?token=` only if worker requires it — v1 uses header on POST and first WS message `hello.authToken` optional.

## Identity (Luna)

- Default reference image on GPU: `/workspace/test_assets/luna.jpg`
- Gateway sends `refImagePath` in `hello` so the worker can override without rebuild.
- Env on gateway: `LUNA_REF_IMAGE_PATH` (default `/workspace/test_assets/luna.jpg`).

## Health (readiness)

Worker SHOULD expose at least one of:

| Method | Path | Response |
|--------|------|----------|
| GET | `/realtime/v1/health` | `{ "ok": true, "model": "echomimic-realtime" }` |
| GET | `/health` | existing worker health (gateway probes this as fallback) |

Gateway `GET /avatar/health` reports `echomimicRealtimeReachable` using the same probe order.

## Session bootstrap (optional HTTP)

`POST /realtime/v1/session`  
Headers: `Content-Type: application/json`, optional `Authorization: Bearer …`  
Body:

```json
{
  "meetingId": "string",
  "sessionId": "string",
  "refImagePath": "/workspace/test_assets/luna.jpg",
  "width": 512,
  "height": 512,
  "targetFps": 20
}
```

Response: `{ "ok": true }` or `{ "ok": true, "sessionToken": "..." }`  
If route returns **404**, gateway skips HTTP bootstrap and relies on WebSocket `hello` only.

## WebSocket stream (primary)

**URL:** `wss://<host>/realtime/v1/ws` (TLS when base is `https://`).

After connect, client → server messages are **JSON text** (UTF-8), one object per frame.

### 1) `hello` (must be first client message)

```json
{
  "type": "hello",
  "meetingId": "…",
  "sessionId": "…",
  "refImagePath": "/workspace/test_assets/luna.jpg",
  "width": 512,
  "height": 512,
  "targetFps": 20,
  "authToken": "optional-same-as-bearer"
}
```

Server → client after acceptance:

```json
{ "type": "ready", "sessionId": "…" }
```

or

```json
{ "type": "error", "message": "…" }
```

### 2) `ingest` (multiplex PCM + optional A2F envelope)

Send for each gateway audio chunk (PCM16 LE, same timeline as OpenAI TTS):

```json
{
  "type": "ingest",
  "timestampMs": 1730000000123,
  "sampleRateHz": 24000,
  "pcm16Base64": "<base64 of raw pcm16 bytes>",
  "a2f": {
    "meetingId": "…",
    "timestamp": 1730000000100,
    "blendshapes": [{ "name": "jawOpen", "value": 0.3 }],
    "emotions": { "neutral": 0.8 },
    "audioPower": 0.12,
    "latencyMs": 15
  }
}
```

`a2f` may be `null` if A2F is disabled; worker still runs lipsync from audio alone.

### 3) Server → client `frame` (low latency)

```json
{
  "type": "frame",
  "ptsMs": 1730000000123,
  "width": 512,
  "height": 512,
  "i420Base64": "<base64 strict I420 size w*h*3/2>"
}
```

Gateway **holds the latest** frame until a newer one arrives; publish cadence follows gateway `AvatarRuntimeEngine` FPS (repeat last frame if worker is slower).

### 4) Ping

Either side may send `{ "type": "ping" }`; peer SHOULD respond `{ "type": "pong" }`. Gateway sends `ping` every 25s.

## Backpressure

- Worker SHOULD drop intermediate frames under GPU load; gateway always publishes **newest** I420 for Stream.
- If no frame was ever received, gateway uses existing static I420 fallback (`AVATAR_VIDEO_DEGRADED_FALLBACK=static`).

## Security

- Run behind RunPod proxy; restrict origins at proxy if exposing browser-facing paths.
- Prefer bearer token known only to gateway + worker.
