# Phase 5A — Luna realtime neural avatar (APPROVED)

**Status:** Approved for implementation (plan locked).  
**Goal:** OpenAI TTS PCM → A2F (8890) → EchoMimicV3 Flash (8889) → low-latency frames → GetStream HR agent video; frontend shows live Luna (not static Anna). No MP4 job path as primary; no Three/VRM/Unity.

## Approved architecture

1. **Identity:** Luna reference image — RunPod `/workspace/test_assets/luna.jpg`; web app `frontend/jobaidemo/public/luna.jpg` for branding/placeholder only.
2. **Gateway:** Continue single path `ingestOpenAiAudioDelta` → A2F `ingestChunk` + realtime adapter toward EchoMimic (8889). Prefer **multiplex** `{ pcm16, a2fEnvelope, ts }` from gateway → 8889 unless RunPod internal A2F→Echo wiring is chosen later.
3. **Frame loop:** Reuse `AvatarRuntimeEngine` tick / backpressure; new **frame source** from 8889 (drop-oldest under load).
4. **Publish:** Existing `StreamAgentPublisher` — one HR video + agent TTS audio.
5. **Frontend:** HR tile subscribes to agent Stream video; placeholder = `luna.jpg` until track frames; bridge 8891 remains optional HUD.

## Wire protocol (frozen)

See [`docs/ECHOMIMIC-8889-REALTIME-WIRE.md`](ECHOMIMIC-8889-REALTIME-WIRE.md).

## Implementation checklist (ordered)

- [x] **Wire protocol:** `docs/ECHOMIMIC-8889-REALTIME-WIRE.md`
- [x] **Env:** `RUNPOD_ECHOMIMIC_REALTIME_URL` (8889 realtime) vs `RUNPOD_RUNTIME_URL` (avatar-generate batch); `LUNA_REF_IMAGE_PATH`; optional `RUNPOD_ECHOMIMIC_REALTIME_BEARER`. A2F: `A2F_GPU_RUNTIME_WS_URL` (8890); bridge: `NEXT_PUBLIC_RUNPOD_BRIDGE_WS_URL` (8891) — README.
- [x] **Gateway:** `EchoMimicRealtimeClient` + `AvatarRuntimeSessionManager` (`VIDEO_MODEL=echomimic_realtime`).
- [x] **Gateway:** WS `ingest` carries PCM + optional A2F JSON per chunk (reconnect: future iteration).
- [x] **Gateway:** `AvatarRuntimeEngine` publishes latest worker I420 at tick FPS; static fallback if no frame yet.
- [x] **DO / smoke:** `GET /avatar/health` → `echomimicRealtimeReachable`, `echomimicRealtimeLatencyMs`.
- [x] **Frontend:** `avatar-stream-card` — `/luna.jpg` placeholder; `ParticipantView` when agent has video.

## Out of scope (explicit)

Offline diffusion, cinematic MP4 jobs as primary path, Three.js/VRM/Unity/WebGL rigs.
