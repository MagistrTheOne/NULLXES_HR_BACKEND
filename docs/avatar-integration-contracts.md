# Avatar Integration Contracts (Gateway + Pod)

## Canonical Redis Session State

Key:
- `session:{meetingId}` (stored with redis prefix from `REDIS_PREFIX`)

Schema (`1.0`):
- `meetingId: string`
- `activeSpeaker: "candidate" | "assistant"`
- `phase: "starting" | "in_meeting" | "paused" | "stopped" | "failed" | "degraded"`
- `engine: "echomimic" | "echomimic_realtime" | "arachne" | "behavior_static" | "none"`
- `degradationLevel: 0 | 1 | 2 | 3 | 4`
- `avatarReady: boolean`
- `revision: number`
- `updatedAtMs: number`
- `ownership.gatewayUpdatedAtMs: number`
- `ownership.podUpdatedAtMs?: number`

Write ownership:
- Gateway writes all fields.
- Pod updates heartbeat via runtime endpoint only.

## Canonical Runtime Events

Mandatory event names:
- `speaker_changed` payload: `{ activeSpeaker: "candidate" | "assistant" }`
- `engine_degraded` payload: `{ degradationLevel: number, reason?: string }`
- `av_sync_warning` payload: `{ driftMs: number }`
- `session_failed` payload: `{ reason: string, error?: string }`
- `runtime.state.synced` payload: `{ commandType: string }`
- `runtime.state.drift_detected` payload: `{ driftMs: number, revision: number }`

Idempotency:
- All pod-sync and speaker change events must include idempotency keys.
- Runtime event store deduplicates by `idempotencyKey` per runtime key.

## Gateway ↔ Pod Command Sync

Commands sent from runtime route to pod:
- `duplex_mode.set`
- `video_audio_source.set`
- `speaker.set`

Policy:
- retry/backoff: `3` attempts (`200ms`, `600ms`, `1500ms`)
- on success emit `runtime.state.synced`
- on failure emit `session_failed` with reason `pod_sync_failed`

## Drift Detection

Signal:
- pod heartbeat endpoint updates `ownership.podUpdatedAtMs`
- if gateway/pod timestamp drift exceeds `10_000ms`, emit `runtime.state.drift_detected`

