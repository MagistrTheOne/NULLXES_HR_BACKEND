import { RunpodWorkerClient } from "../dist/services/runpodWorkerClient.js";

async function main() {
  process.env.RUNPOD_WORKER_URL ||= "http://127.0.0.1:18000";
  process.env.RUNPOD_WORKER_TIMEOUT_MS ||= "5000";

  const client = new RunpodWorkerClient();
  const resp = await client.generateClip({
    sessionId: "session-1",
    meetingId: "meeting-1",
    epoch: 0,
    audioPcm16Base64: Buffer.alloc(48000, 0).toString("base64"),
    audioSampleRate: 24000,
    fps: 25,
    width: 512,
    height: 512,
    numFrames: 25,
    numInferenceSteps: 3,
    seed: 1,
    prompt: "test",
    negativePrompt: "test"
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, frames: resp.frames.length, epoch: resp.epoch, telemetry: resp.telemetry }, null, 2));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

