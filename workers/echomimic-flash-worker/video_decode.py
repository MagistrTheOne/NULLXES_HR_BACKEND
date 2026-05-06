import base64
from typing import List, Dict, Any

import cv2
import numpy as np


def mp4_to_i420_frames(mp4_path: str, fps: int) -> List[Dict[str, Any]]:
    cap = cv2.VideoCapture(mp4_path)
    if not cap.isOpened():
        raise RuntimeError(f"failed to open video: {mp4_path}")

    frames = []
    idx = 0
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            # Convert BGR -> I420 (YUV 4:2:0 planar)
            i420 = cv2.cvtColor(bgr, cv2.COLOR_BGR2YUV_I420)
            # i420 is H*1.5 x W single-channel array
            raw = i420.tobytes()
            frames.append(
                {
                    "ptsMs": int(idx * 1000 / fps),
                    "i420Base64": base64.b64encode(raw).decode("ascii"),
                }
            )
            idx += 1
    finally:
        cap.release()

    return frames


def decode_pcm16_base64_to_bytes(pcm16_b64: str) -> bytes:
    return base64.b64decode(pcm16_b64.encode("ascii"))

