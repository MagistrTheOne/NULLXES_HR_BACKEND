# Runtime bridge (8891) — smoke tests and known failure (2026-05-11)

## Context

Smoke was run from `/workspace/runtime-bridge` (venv) against:

`ws://127.0.0.1:8891/realtime/v1/ws`

Flow: `hello` → `ingest` (PCM24k, 2s sine) → wait for `frame` / errors.

**Observed:** `hello` returned `ready` with `model: echomimic-v3-microbatch`. Subsequent path failed with:

```text
echomimic_generate_failed: ReadTimeout: ReadTimeout('')
```

GPU was observed warming (inference path touched); **no stable frame output** in this run. **Disk/cache pressure** was suspected (cache exhausted during iteration) — treat as environmental until reproduced on a clean volume.

**Upstream reference (EchoMimicV3):** [antgroup/echomimic_v3](https://github.com/antgroup/echomimic_v3)

## Fast smoke (minimal surface, no long audio)

Prefer **layered** checks so a single timeout does not burn 2s of PCM + full microbatch every time.

### 1) Process and port (no Python)

```bash
ss -lntp | grep -E '8891|8889|8890' || true
curl -sS --max-time 3 http://127.0.0.1:8891/health 2>/dev/null || curl -sS --max-time 3 http://127.0.0.1:8891/realtime/v1/health 2>/dev/null || true
```

If the bridge exposes HTTP health, keep `--max-time` low so smoke never hangs.

### 2) WebSocket: hello only (no ingest)

```bash
python - <<'PY'
import asyncio, json, websockets

async def main():
    async with websockets.connect("ws://127.0.0.1:8891/realtime/v1/ws", max_size=16_000_000, ping_timeout=20) as ws:
        await ws.send(json.dumps({
            "type": "hello",
            "sessionId": "smoke-hello-only",
            "refImagePath": "/workspace/test_assets/luna.jpg",
            "width": 512,
            "height": 512,
            "fps": 8
        }))
        msg = await asyncio.wait_for(ws.recv(), timeout=15)
        print(msg)

asyncio.run(main())
PY
```

Expect: `ready` JSON. If this fails, fix auth / ref image / worker before any ingest.

### 3) WebSocket: tiny ingest (not 2 seconds)

Use **100–200 ms** of PCM at 24 kHz (order hundreds of samples, not 48k). Same `ingest` schema; one or two messages only.

```python
# example: 120 ms @ 24kHz mono int16
sr = 24000
ms = 120
n = int(sr * ms / 1000)
samples = [int(3000 * __import__("math").sin(2 * __import__("math").pi * 220 * i / sr)) for i in range(n)]
```

If the bridge blocks until a full microbatch, shorten further or align `fps` / worker `partial_video_length` with upstream EchoMimic guidance ([README](https://github.com/antgroup/echomimic_v3)).

### 4) Gateway-side smoke (if 8889 wire is in play)

See [ECHOMIMIC-8889-REALTIME-WIRE.md](./ECHOMIMIC-8889-REALTIME-WIRE.md) and `GET /avatar/health` on the gateway for `echomimicRealtimeReachable` / latency — avoids custom bridge scripts when the path is gateway → 8889.

## ReadTimeout — quick triage

| Check | Action |
|--------|--------|
| Disk | `df -h /workspace /tmp` — HF/torch caches often fill `/workspace` or `$TMPDIR` |
| HF cache | `echo $HF_HOME $TRANSFORMERS_CACHE` — ensure large enough or point to volume |
| Worker logs | `tail -100 /workspace/bridge.log` (or container stdout) at same timestamp as timeout |
| Timeout budget | Increase client `read` timeout only after hello passes; keep ingest payloads small for iteration |
| Cold vs warm | First frame after deploy is often slow; one **warmup** hello+50ms ingest, then measure |

## Next week (tracked)

- Re-run layered smoke after cache/disk cleanup or fresh volume.
- Wire remaining pipeline pieces per Phase 5A plan ([PHASE-5A-LUNA-REALTIME.md](./PHASE-5A-LUNA-REALTIME.md)).
- If 8891 remains a dev shim, document its contract beside 8889 so gateway and RunPod stay aligned.

---

*File created: 2026-05-11. Adjust host/paths if bridge listens on a different interface or path.*
