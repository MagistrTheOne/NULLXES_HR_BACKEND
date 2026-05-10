# Phase 5A — Luna realtime neural avatar (APPROVED)

**Status:** Approved for implementation (plan locked).  
**Goal:** OpenAI TTS PCM → A2F (8890) → EchoMimicV3 Flash (8889) → low-latency frames → GetStream HR agent video; frontend shows live Luna (not static Anna). No MP4 job path as primary; no Three/VRM/Unity.

## Approved architecture

1. **Identity:** Luna reference image — RunPod `/workspace/test_assets/luna.jpg`; web app `frontend/jobaidemo/public/luna.jpg` for branding/placeholder only.
2. **Gateway:** Continue single path `ingestOpenAiAudioDelta` → A2F `ingestChunk` + realtime adapter toward EchoMimic (8889). Prefer **multiplex** `{ pcm16, a2fEnvelope, ts }` from gateway → 8889 unless RunPod internal A2F→Echo wiring is chosen later.
3. **Frame loop:** Reuse `AvatarRuntimeEngine` tick / backpressure; new **frame source** from 8889 (drop-oldest under load).
4. **Publish:** Existing `StreamAgentPublisher` — one HR video + agent TTS audio.
5. **Frontend:** HR tile subscribes to agent Stream video; placeholder = `luna.jpg` until track frames; bridge 8891 remains optional HUD.

## Implementation checklist (ordered)

- [ ] **Wire protocol:** Document 8889 realtime API (auth, frame format, session start, Luna ref path) in this file or `README.md`.
- [ ] **Env:** Split/clarify `RUNPOD_RUNTIME_URL` (8889) vs any generate-only URL; document `A2F_GPU_RUNTIME_WS_URL` (8890), optional `NEXT_PUBLIC_RUNPOD_BRIDGE_WS_URL` (8891).
- [ ] **Gateway:** `echoMimicRealtimeClient` (or extend `RunpodWorkerClient`) + session lifecycle tied to `AvatarRuntimeSessionManager`.
- [ ] **Gateway:** Feed aligned A2F envelopes + PCM into 8889; handle reconnect.
- [ ] **Gateway:** `AvatarRuntimeEngine` / `VIDEO_MODEL` branch for realtime frames → I420 publish (or accept I420 from pod).
- [ ] **DO:** Systemd/env smoke — `GET /avatar/health`, probe `gpuReachable`.
- [ ] **Frontend:** `avatar-stream-card` — Luna placeholder + prioritize live agent `<video>` when track active.

## Out of scope (explicit)

Offline diffusion, cinematic MP4 jobs as primary path, Three.js/VRM/Unity/WebGL rigs.
