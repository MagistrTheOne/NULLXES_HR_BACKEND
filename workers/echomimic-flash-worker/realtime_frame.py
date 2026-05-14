"""
MVP realtime I420 frame synthesis for WebSocket streaming.

This is NOT full EchoMimic neural streaming yet — it proves the wire protocol and
produces valid I420 frames from Luna + audio energy + A2F jaw hints so the gateway
can publish a live Stream video track. Replace `build_i420_frame` body with true
infer when the model exposes a streaming API.
"""

from __future__ import annotations

import base64
import math
import struct
import time
from typing import Any, Dict, Optional

import cv2
import numpy as np
from PIL import Image, ImageOps


def pcm16_rms_normalized(pcm_bytes: bytes) -> float:
    if len(pcm_bytes) < 4:
        return 0.0
    n = len(pcm_bytes) // 2
    samples = struct.unpack("<" + "h" * n, pcm_bytes[: n * 2])
    if not samples:
        return 0.0
    acc = sum(s * s for s in samples)
    rms = math.sqrt(acc / len(samples))
    return float(min(1.0, max(0.0, rms / 8000.0)))


def jaw_open_from_a2f(a2f: Optional[Dict[str, Any]]) -> float:
    if not a2f or not isinstance(a2f, dict):
        return 0.0
    blend = a2f.get("blendshapes")
    if not isinstance(blend, list):
        ap = a2f.get("audioPower")
        if isinstance(ap, (int, float)):
            return float(min(1.0, max(0.0, float(ap) * 2.0)))
        return 0.0
    patterns = ("jaw", "open"), ("mouth", "open")
    best = 0.0
    for item in blend:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).lower()
        val = item.get("value")
        if not isinstance(val, (int, float)):
            continue
        v = float(val)
        for a, b in patterns:
            if a in name and b in name:
                best = max(best, min(1.0, max(0.0, v)))
    if best > 0:
        return best
    ap = a2f.get("audioPower")
    if isinstance(ap, (int, float)):
        return float(min(1.0, max(0.0, float(ap) * 2.0)))
    return 0.0


def load_ref_bgr(path: str) -> np.ndarray:
    """Load reference image with EXIF orientation applied (BGR uint8)."""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    rgb = np.array(img.convert("RGB"))
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def _mouth_modulate_bgr(bgr: np.ndarray, intensity: float) -> np.ndarray:
    """Subtle mouth-region brightening driven by 0..1 intensity (micro-motion)."""
    h, w = bgr.shape[:2]
    out = bgr.copy()
    cx, cy = w // 2, int(h * 0.58)
    rx = max(4, int(w * 0.14))
    ry = max(3, int(h * 0.06))
    boost = int(22 * min(1.0, max(0.0, intensity)))
    if boost <= 0:
        return out
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.ellipse(mask, (cx, cy), (rx, ry), 0, 0, 360, 255, -1)
    for c in range(3):
        ch = out[:, :, c]
        ch = np.where(mask > 0, np.clip(ch.astype(np.int16) + boost, 0, 255).astype(np.uint8), ch)
        out[:, :, c] = ch
    return out


def build_i420_frame(ref_bgr: np.ndarray, width: int, height: int, mouth: float, rms: float) -> bytes:
    """Resize ref, apply micro modulation, return raw I420 bytes."""
    resized = cv2.resize(ref_bgr, (width, height), interpolation=cv2.INTER_AREA)
    m = min(1.0, max(0.0, 0.55 * mouth + 0.45 * rms))
    mod = _mouth_modulate_bgr(resized, m)
    i420 = cv2.cvtColor(mod, cv2.COLOR_BGR2YUV_I420)
    return i420.tobytes()


def frame_packet_json(timestamp_ms: int, width: int, height: int, i420: bytes) -> Dict[str, Any]:
    return {
        "type": "frame",
        "timestamp": timestamp_ms,
        "ptsMs": timestamp_ms,
        "width": width,
        "height": height,
        "format": "i420",
        "data": base64.b64encode(i420).decode("ascii"),
        # legacy alias for older gateway parsers
        "i420Base64": base64.b64encode(i420).decode("ascii"),
    }
