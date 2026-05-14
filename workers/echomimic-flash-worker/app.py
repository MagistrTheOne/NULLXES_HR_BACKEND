import asyncio
import base64
import json
import os
import tempfile
import time
import wave
from typing import Optional, Literal, Dict, Any

import subprocess
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from echomimic_runner import EchoMimicFlashConfig, run_infer_flash
from realtime_frame import (
    build_i420_frame,
    frame_packet_json,
    jaw_open_from_a2f,
    load_ref_bgr,
    pcm16_rms_normalized,
)
from video_decode import mp4_to_i420_frames, decode_pcm16_base64_to_bytes

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


def _cuda_available() -> bool:
    try:
        import torch  # type: ignore

        return bool(torch.cuda.is_available())
    except Exception:
        return False


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(ok=True, model="echomimicv3-flash", cuda=_cuda_available())


@app.get("/realtime/v1/health")
def realtime_v1_health() -> Dict[str, Any]:
    return {
        "ok": True,
        "service": "echomimic-flash-worker",
        "model": "echomimic-realtime-mvp",
        "realtime": True,
        "cuda": _cuda_available(),
    }


@app.post("/realtime/v1/session")
async def realtime_v1_session(request: Request) -> Dict[str, Any]:
    try:
        await request.json()
    except Exception:
        pass
    return {"ok": True}


@app.websocket("/realtime/v1/ws")
async def realtime_v1_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    ref_bgr = None
    width, height = 512, 512
    fps = 24
    min_interval = 1.0 / max(1, fps)
    last_sent_mono = 0.0
    loop = asyncio.get_event_loop()

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "invalid_json"})
                continue

            mtype = msg.get("type")
            if mtype == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            if mtype == "hello":
                sid = str(msg.get("sessionId", ""))
                ref_path = msg.get("refImagePath") or os.environ.get(
                    "DEFAULT_REF_IMAGE", os.path.join(_cfg.repo_dir, "nullxes_refs/ref.jpg")
                )
                if not ref_path or not os.path.isfile(str(ref_path)):
                    await websocket.send_json(
                        {
                            "type": "error",
                            "message": "ref_image_not_found",
                            "refImagePath": ref_path,
                        }
                    )
                    continue
                width = int(msg.get("width", 512))
                height = int(msg.get("height", 512))
                width = max(64, min(1024, width))
                height = max(64, min(1024, height))
                fps = int(msg.get("fps") or msg.get("targetFps") or 24)
                fps = max(1, min(60, fps))
                min_interval = 1.0 / fps

                def _load_ref() -> Any:
                    return load_ref_bgr(str(ref_path))

                ref_bgr = await loop.run_in_executor(None, _load_ref)
                await websocket.send_json(
                    {
                        "type": "ready",
                        "sessionId": sid,
                        "width": width,
                        "height": height,
                        "fps": fps,
                    }
                )
                continue

            if mtype == "ingest":
                if ref_bgr is None:
                    await websocket.send_json({"type": "error", "message": "hello_required"})
                    continue

                ts = msg.get("timestampMs")
                if ts is None:
                    ts = msg.get("timestamp")
                ts_ms = int(ts) if ts is not None else int(time.time() * 1000)

                pcm_b64 = msg.get("pcm16Base64") or msg.get("pcm")
                if not pcm_b64 or not isinstance(pcm_b64, str):
                    continue
                try:
                    pcm_bytes = base64.b64decode(pcm_b64.encode("ascii"))
                except Exception:
                    await websocket.send_json({"type": "error", "message": "pcm_decode_failed"})
                    continue

                sr = msg.get("sampleRateHz") or msg.get("sampleRate") or 24000
                _ = sr  # reserved for true streaming infer

                a2f_raw = msg.get("a2f")
                a2f: Optional[Dict[str, Any]] = a2f_raw if isinstance(a2f_raw, dict) else None

                now = time.monotonic()
                if now - last_sent_mono < min_interval:
                    continue
                last_sent_mono = now

                rms = pcm16_rms_normalized(pcm_bytes)
                jaw = jaw_open_from_a2f(a2f)

                def _build() -> bytes:
                    return build_i420_frame(ref_bgr, width, height, jaw, rms)

                i420 = await loop.run_in_executor(None, _build)
                await websocket.send_json(frame_packet_json(ts_ms, width, height, i420))
                continue

            await websocket.send_json({"type": "error", "message": f"unknown_type:{mtype}"})
    except WebSocketDisconnect:
        return
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass


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

