import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, model: "echomimicv3-flash", cuda: false });
});

app.post("/generate_clip", (req, res) => {
  const { sessionId, meetingId, epoch, fps, width, height, numFrames, numInferenceSteps } = req.body ?? {};
  // Return black frames (I420) for smoke tests only.
  const w = Number(width) || 512;
  const h = Number(height) || 512;
  const frameSize = Math.floor(w * h * 1.5);
  const raw = Buffer.alloc(frameSize, 16); // arbitrary Y value
  const i420Base64 = raw.toString("base64");
  const frames = Array.from({ length: Number(numFrames) || 25 }, (_v, i) => ({
    ptsMs: Math.floor((i * 1000) / (Number(fps) || 25)),
    i420Base64
  }));
  res.json({
    sessionId: sessionId || "s",
    meetingId: meetingId || "m",
    epoch: Number(epoch) || 0,
    fps: Number(fps) || 25,
    width: w,
    height: h,
    frames,
    telemetry: {
      model: "echomimicv3-flash",
      clipLatencyMs: 50,
      queueDepth: 1,
      gpuMemoryMb: 0,
      numFrames: Number(numFrames) || 25,
      numInferenceSteps: Number(numInferenceSteps) || 3
    }
  });
});

const port = Number(process.env.PORT || 18000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`mock runpod worker listening on :${port}`);
});

