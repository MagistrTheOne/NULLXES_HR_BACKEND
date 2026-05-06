import os
import subprocess
from dataclasses import dataclass


@dataclass
class EchoMimicFlashConfig:
    repo_dir: str = "/workspace/EchoMimicV3"
    venv_activate: str = "/workspace/echovenv/bin/activate"
    infer_script: str = "infer_flash.py"
    config_path: str = "config/config.yaml"
    model_name: str = "./flash/Wan2.1-Fun-V1.1-1.3B-InP"
    ckpt_idx: str = "50000"
    transformer_path: str = "./flash/transformer/diffusion_pytorch_model.safetensors"
    wav2vec_model_dir: str = "./flash/chinese-wav2vec2-base"
    sampler_name: str = "Flow_Unipc"


def run_infer_flash(
    cfg: EchoMimicFlashConfig,
    *,
    image_path: str,
    audio_path: str,
    prompt: str,
    negative_prompt: str,
    num_inference_steps: int,
    video_length: int,
    guidance_scale: float,
    audio_guidance_scale: float,
    seed: int,
    fps: int,
    width: int,
    height: int,
    out_dir: str,
) -> str:
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "out.mp4")

    cmd = [
        "bash",
        "-lc",
        " ".join(
            [
                f"cd {cfg.repo_dir}",
                f"source {cfg.venv_activate}",
                "python",
                cfg.infer_script,
                "--image_path",
                image_path,
                "--audio_path",
                audio_path,
                "--prompt",
                _shell_quote(prompt),
                "--num_inference_steps",
                str(num_inference_steps),
                "--config_path",
                cfg.config_path,
                "--model_name",
                cfg.model_name,
                "--ckpt_idx",
                cfg.ckpt_idx,
                "--transformer_path",
                cfg.transformer_path,
                "--save_path",
                out_dir,
                "--wav2vec_model_dir",
                cfg.wav2vec_model_dir,
                "--sampler_name",
                cfg.sampler_name,
                "--video_length",
                str(video_length),
                "--guidance_scale",
                str(guidance_scale),
                "--audio_guidance_scale",
                str(audio_guidance_scale),
                "--seed",
                str(seed),
                "--weight_dtype",
                "bfloat16",
                "--sample_size",
                str(width),
                str(height),
                "--fps",
                str(fps),
                "--negative_prompt",
                _shell_quote(negative_prompt),
            ]
        ),
    ]

    # EchoMimic writes outputs/*_output.mp4 by default; we normalize by picking the newest mp4.
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    # Find produced mp4 (newest).
    newest = None
    newest_mtime = -1
    for root, _dirs, files in os.walk(out_dir):
        for f in files:
            if not f.lower().endswith(".mp4"):
                continue
            p = os.path.join(root, f)
            m = os.path.getmtime(p)
            if m > newest_mtime:
                newest_mtime = m
                newest = p
    if not newest:
        raise RuntimeError("infer_flash produced no mp4 output")
    return newest


def _shell_quote(s: str) -> str:
    return "'" + s.replace("'", "'\"'\"'") + "'"

