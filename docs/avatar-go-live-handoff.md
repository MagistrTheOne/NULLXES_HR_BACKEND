# Avatar Go-Live Handoff (Week 14.05.2026)

## Pre-flight
- Ensure gateway and pod use the same `REDIS_URL` and `REDIS_PREFIX`.
- Verify `VIDEO_MODEL=echomimic` and `RUNPOD_WORKER_URL` are configured.
- Verify `STREAM_API_KEY/STREAM_API_SECRET` and avatar pod auth are valid.

## Runtime Checks
- `GET /health`
- `GET /health/ready`
- `GET /runtime/{meetingId}/state`
- `GET /runtime/{meetingId}/avatar-stats`

## Burn-in Procedure (10+ min)
1. Start a meeting via control API.
2. Keep session active for at least 10 minutes.
3. During run:
   - execute pause/resume at least 3 times
   - trigger speaker switches (candidate/assistant)
4. Confirm:
   - no repeated stale speech after resume
   - no uncontrolled queue growth
   - state revision keeps increasing without drift alarms

## Rollback
- Rollback code to last stable backend commit.
- Restart backend service.
- Keep Redis keys for post-mortem unless incident severity requires cleanup.

## Escalation
- If `session_failed` events spike with `pod_sync_failed`, escalate to pod owner.
- If `runtime.state.drift_detected` appears repeatedly (>3 in 5 min), pause rollout.

