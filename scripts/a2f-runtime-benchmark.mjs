#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.GATEWAY_BASE_URL ?? "http://127.0.0.1:8080";
const sessionCount = Number(process.env.A2F_BENCH_SESSIONS ?? 4);
const durationSec = Number(process.env.A2F_BENCH_DURATION_SEC ?? 30);
const sampleRate = 16_000;
const chunkMs = 20;
const chunkSamples = Math.floor((sampleRate * chunkMs) / 1000);

console.log(`[bench] baseUrl=${baseUrl} sessions=${sessionCount} durationSec=${durationSec}`);
console.log("[bench] expecting running gateway with active runtime sessions");

const meetingIds = Array.from({ length: sessionCount }, (_, idx) => `nullxes-meeting-bench-${idx + 1}`);
for (const meetingId of meetingIds) {
  await fetchJson(`${baseUrl}/runtime/${encodeURIComponent(meetingId)}/commands`, {
    method: "POST",
    body: JSON.stringify({
      type: "observer.reconnect",
      issuedBy: "bench"
    }),
    headers: { "content-type": "application/json" }
  }).catch(() => undefined);
}

const startedAt = Date.now();
while (Date.now() - startedAt < durationSec * 1000) {
  await Promise.all(
    meetingIds.map(async (meetingId, index) => {
      const hz = 220 + index * 30;
      const pcm16 = createSinePcm(chunkSamples, sampleRate, hz);
      const body = {
        type: "realtime.session.event",
        sessionId: meetingId,
        actor: "bench",
        payload: {
          type: "response.audio.delta",
          delta: Buffer.from(pcm16.buffer).toString("base64"),
          timestampMs: Date.now()
        }
      };
      await fetchJson(`${baseUrl}/runtime/${encodeURIComponent(meetingId)}/events`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" }
      }).catch(() => undefined);
    })
  );
  await delay(chunkMs);
}

const report = await fetchJson(`${baseUrl}/runtime/a2f/sessions`);
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  sessions: sessionCount,
  durationSec,
  result: report
}, null, 2));

async function fetchJson(url, init = undefined) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }
  return response.json();
}

function createSinePcm(length, sampleRateHz, hz) {
  const out = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRateHz;
    out[i] = Math.floor(Math.sin(t * hz * Math.PI * 2) * 0.3 * 32767);
  }
  return out;
}

