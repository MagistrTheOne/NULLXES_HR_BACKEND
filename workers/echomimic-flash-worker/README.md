# EchoMimicV3 Flash RunPod worker (inference-only)

This worker is **inference-only** for batch clips, plus an **MVP realtime** path for end-to-end wiring:

- `GET /health`
- `POST /generate_clip`
- `GET /realtime/v1/health`
- `POST /realtime/v1/session` (optional bootstrap; returns `{ "ok": true }`)
- `WebSocket /realtime/v1/ws` — JSON `hello` then `ingest` (PCM16 + optional A2F); server streams I420 `frame` messages (see [`../../docs/ECHOMIMIC-8889-REALTIME-WIRE.md`](../../docs/ECHOMIMIC-8889-REALTIME-WIRE.md)).

Realtime frames today are **MVP**: resized Luna + audio RMS + A2F jaw hint → valid I420 (not full EchoMimic neural streaming yet). Replace the body of `realtime_frame.build_i420_frame` when a streaming infer API is available.

It **does not** run Stream SDK or WebRTC.

## RunPod setup (H200)

Assumptions:
- EchoMimicV3 repo lives at `/workspace/EchoMimicV3`
- venv at `/workspace/echovenv`
- You already confirmed `infer_flash.py` works.

### Install deps

```bash
cd /workspace/NULLXES_HR_BACKEND/workers/echomimic-flash-worker || exit 1
source /workspace/echovenv/bin/activate
pip install -r requirements-worker.txt
```

### Start worker (port 8000)

```bash
cd /workspace/NULLXES_HR_BACKEND/workers/echomimic-flash-worker
source /workspace/echovenv/bin/activate
export DEFAULT_REF_IMAGE=/workspace/EchoMimicV3/nullxes_refs/ref.jpg
export PORT=8000
./run_worker.sh
```

## Gateway env (droplet)

Add to gateway `.env`:

```bash
VIDEO_MODEL=echomimic
RUNPOD_WORKER_URL=https://<your-runpod-worker>-8000.proxy.runpod.net
RUNPOD_WORKER_TIMEOUT_MS=120000
```

## Smoke: gateway → worker

Run mock worker locally:

```bash
cd backend/realtime-gateway
node scripts/mock-runpod-worker.mjs
```

Then in another shell (after `npm run build`):

```bash
cd backend/realtime-gateway
RUNPOD_WORKER_URL=http://127.0.0.1:18000 node scripts/test-runpod-worker-client.mjs
```

### Smoke

```bash
curl -sS http://127.0.0.1:8000/health
```

## Contract

### POST /generate_clip (request)

Fields match the gateway expectations:
- `epoch` is echoed back (stale responses can be dropped by gateway)
- `audioPcm16Base64` is **PCM16 LE mono**\n+
### Response
- `frames[]` contains `ptsMs` + `i420Base64` (publish-ready for `RTCVideoSource.onFrame`).

