# A2F Realtime Runtime (Production)

This gateway now includes a production-oriented `services/a2f-runtime/` pipeline:

- PCM16 mono 16kHz chunks
- lock-free ring buffer
- sliding-window inference loop (A2F + A2EM)
- websocket output fanout

## Service layout

- `src/services/a2f-runtime/contracts.ts`
- `src/services/a2f-runtime/audio/lockFreePcmRingBuffer.ts`
- `src/services/a2f-runtime/a2fRuntimeService.ts`
- `src/services/a2f-runtime/runtimeServiceClient.ts`
- `src/services/a2f-runtime/a2fFrameWsHub.ts`

## Browser transport

- WebSocket endpoint:
  - `ws://<host>/ws/runtime/:meetingId/facial?format=json`
  - `ws://<host>/ws/runtime/:meetingId/facial?format=protobuf`

Primary mode is JSON payloads:

```json
{
  "timestamp": 1778450000123,
  "blendshapes": [{ "name": "jawOpen", "value": 0.42 }],
  "emotions": { "calm": 0.65, "excited": 0.2, "neutral": 0.75 },
  "audioPower": 0.11,
  "latencyMs": 18
}
```

## Runtime stats endpoints

- `GET /runtime/:meetingId/facial-stats`
- `GET /runtime/a2f/sessions`

## Benchmark

Use:

```bash
node scripts/a2f-runtime-benchmark.mjs
```

Optional env:

- `GATEWAY_BASE_URL`
- `A2F_BENCH_SESSIONS`
- `A2F_BENCH_DURATION_SEC`

