import base64
import os
import tempfile
import time
import wave
from typing import Optional, Literal, Dict, Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from echomimic_runner import EchoMimicFlashConfig, run_infer_flash
from video_decode import mp4_to_i420_frames, decode_pcm16_base64_to_bytes
import subprocess

app = FastAPI(title="NULLXES EchoMimicV3 Flash Worker", version="1.0.0")


class GenerateClipRequest(BaseModel):
    sessionId: str
    meetingId: str
    epoch: int
    audioPcm16Base64: str
    audioSampleRate: int = Field(..., description="16000/24000/48000")
    refImageBase64: Optional[str] = None
    avatarKey: Optional[str] = None
    fps: int = 25
    width: int = 512
    height: int = 512
    numFrames: int = 25
    numInferenceSteps: int = 5
    seed: int = 44
    prompt: str
    negativePrompt: str


class FrameItem(BaseModel):
    ptsMs: int
    i420Base64: str


class TelemetryItem(BaseModel):
    model: Literal["echomimicv3-flash"] = "echomimicv3-flash"
    clipLatencyMs: int
    queueDepth: int
    gpuMemoryMb: Optional[int] = None
    numFrames: int
    numInferenceSteps: int


class GenerateClipResponse(BaseModel):
    sessionId: str
    meetingId: str
    epoch: int
    fps: int
    width: int
    height: int
    frames: list[FrameItem]
    telemetry: TelemetryItem


class HealthResponse(BaseModel):
    ok: bool
    model: str
    cuda: bool


_cfg = EchoMimicFlashConfig()
_queue_depth = 0


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    try:
        import torch  # type: ignore

        cuda = bool(torch.cuda.is_available())
    except Exception:
        cuda = False
    return HealthResponse(ok=True, model="echomimicv3-flash", cuda=cuda)


def _write_wav_pcm16(path: str, pcm16_bytes: bytes, sample_rate: int) -> None:
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm16_bytes)


@app.post("/generate_clip", response_model=GenerateClipResponse)
def generate_clip(req: GenerateClipRequest) -> GenerateClipResponse:
    global _queue_depth
    _queue_depth += 1
    t0 = time.time()
    try:
        pcm16_bytes = decode_pcm16_base64_to_bytes(req.audioPcm16Base64)

        with tempfile.TemporaryDirectory(prefix="nullxes-echomimic-") as tmp:
            audio_path = os.path.join(tmp, "audio.wav")
            _write_wav_pcm16(audio_path, pcm16_bytes, req.audioSampleRate)

            # Reference image
            if req.refImageBase64:
                img_path = os.path.join(tmp, "ref.jpg")
                with open(img_path, "wb") as f:
                    f.write(base64.b64decode(req.refImageBase64.encode("ascii")))
            else:
                # Default ref image path (configurable on RunPod)
                img_path = os.environ.get("DEFAULT_REF_IMAGE", os.path.join(_cfg.repo_dir, "nullxes_refs/ref.jpg"))
                if not os.path.exists(img_path):
                    raise HTTPException(status_code=400, detail="refImageBase64 missing and DEFAULT_REF_IMAGE not found")

            out_dir = os.path.join(tmp, "out")
            mp4_path = run_infer_flash(
                _cfg,
                image_path=img_path,
                audio_path=audio_path,
                prompt=req.prompt,
                negative_prompt=req.negativePrompt,
                num_inference_steps=req.numInferenceSteps,
                video_length=req.numFrames,
                guidance_scale=5.0,
                audio_guidance_scale=2.0,
                seed=req.seed,
                fps=req.fps,
                width=req.width,
                height=req.height,
                out_dir=out_dir,
            )

            frames = mp4_to_i420_frames(mp4_path, req.fps)
            t1 = time.time()
            latency_ms = int((t1 - t0) * 1000)

            return GenerateClipResponse(
                sessionId=req.sessionId,
                meetingId=req.meetingId,
                epoch=req.epoch,
                fps=req.fps,
                width=req.width,
                height=req.height,
                frames=[FrameItem(**f) for f in frames],
                telemetry=TelemetryItem(
                    clipLatencyMs=latency_ms,
                    queueDepth=_queue_depth,
                    gpuMemoryMb=None,
                    numFrames=req.numFrames,
                    numInferenceSteps=req.numInferenceSteps,
                ),
            )
    except HTTPException:
        raise
    except subprocess.CalledProcessError as e:  # noqa: F821
        raise HTTPException(status_code=500, detail=f"infer_flash failed: {e}") from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    finally:
        _queue_depth = max(0, _queue_depth - 1)

