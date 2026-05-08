#!/usr/bin/env node
/* eslint-disable no-console */

const baseUrl = process.env.GATEWAY_BASE_URL || "http://127.0.0.1:8080";
const meetingId = process.env.MEETING_ID || "";

function fail(message) {
  console.error(`SMOKE_FAIL: ${message}`);
  process.exit(1);
}

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    fail(`${url} -> ${response.status} ${body.slice(0, 300)}`);
  }
  return await response.json();
}

async function main() {
  console.log("Phase2 Sprint1-2 smoke started");
  console.log(`Gateway: ${baseUrl}`);

  const health = await readJson(`${baseUrl}/health`);
  console.log("health:", health.status);

  if (!meetingId) {
    console.log("MEETING_ID is not provided: runtime checks skipped.");
    console.log("Set MEETING_ID and rerun to validate avatar runtime stats.");
    process.exit(0);
  }

  const statsPayload = await readJson(`${baseUrl}/runtime/${encodeURIComponent(meetingId)}/avatar-stats`);
  const stats = statsPayload?.stats;
  if (!stats) {
    fail("avatar runtime stats unavailable for this meeting");
  }

  const engine = stats.engine || {};
  console.log("runtime.state:", stats.state);
  console.log("runtime.clockMs:", stats.clockMs);
  console.log("orchestrator:", stats.orchestrator);
  console.log("engine.micRingSizeMs:", engine.micRingSizeMs);
  console.log("engine.ttsRingSizeMs:", engine.ttsRingSizeMs);
  console.log("engine.underrunCount:", engine.underrunCount);
  console.log("engine.audioQueueDropCount:", engine.audioQueueDropCount);
  console.log("engine.chunkViolationCount:", engine.chunkViolationCount);

  console.log("Phase2 Sprint1-2 smoke completed");
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));

