#!/usr/bin/env node
/* eslint-disable no-console */

const baseUrl = process.env.GATEWAY_BASE_URL || "http://127.0.0.1:8080";
const meetingId = process.env.MEETING_ID;

if (!meetingId) {
  console.error("MEETING_ID is required");
  process.exit(1);
}

async function readJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function main() {
  const state = await readJson(`${baseUrl}/runtime/${encodeURIComponent(meetingId)}/state`);
  const stats = await readJson(`${baseUrl}/runtime/${encodeURIComponent(meetingId)}/avatar-stats`);
  const events = await readJson(`${baseUrl}/runtime/${encodeURIComponent(meetingId)}/events?afterRevision=0`);

  const warningEvents = (events.events || []).filter((e) =>
    ["session_failed", "av_sync_warning", "runtime.state.drift_detected"].includes(e.type)
  );

  console.log("state:", state.state);
  console.log("stats:", stats.stats?.engine ?? null);
  console.log("warningsCount:", warningEvents.length);
  if (warningEvents.length > 0) {
    console.log("warnings:", warningEvents.map((e) => ({ type: e.type, payload: e.payload })));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

