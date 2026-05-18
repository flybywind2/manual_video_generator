from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from backend.app.adapters.skills import ensure_hyperframes_skills
from backend.app.config import AppSettings


CommandRunner = Callable[..., subprocess.CompletedProcess]


@dataclass(frozen=True)
class VideoRenderResult:
    video_path: Path
    composition_dir: Path
    metadata_path: Path
    skills_metadata_path: Path
    used_fallback: bool


def render_final_video(
    *,
    plan: dict[str, Any],
    package_dir: Path,
    preview_html: Path,
    fallback_video: Path,
    settings: AppSettings,
    command_runner: CommandRunner | None = None,
) -> VideoRenderResult:
    composition_dir = _write_hyperframes_composition(plan, package_dir, preview_html, fallback_video)
    metadata_path = package_dir / "video_render.json"
    runner = subprocess.run if command_runner is None else command_runner
    renderer = settings.video_renderer.lower()

    metadata: dict[str, Any] = {
        "renderer": renderer,
        "composition_dir": str(composition_dir),
        "preview_html": str(preview_html),
        "fallback_video": str(fallback_video),
        "used_fallback": True,
    }
    skills = ensure_hyperframes_skills(settings, package_dir)
    metadata["skills_metadata"] = str(skills.metadata_path)
    metadata["skills_status"] = skills.status
    if renderer != "hyperframes":
        metadata["status"] = "skipped"
        metadata["reason"] = "video renderer is not hyperframes"
        _write_metadata(metadata_path, metadata)
        return VideoRenderResult(fallback_video, composition_dir, metadata_path, skills.metadata_path, True)

    output_path = package_dir / "manual_video_agent_usage.mp4"
    command = _split_command(settings.hyperframes_command)
    if command:
        resolved = shutil.which(command[0])
        if resolved:
            command[0] = resolved
    if not command:
        metadata["status"] = "skipped"
        metadata["reason"] = "hyperframes command is empty"
        _write_metadata(metadata_path, metadata)
        return VideoRenderResult(fallback_video, composition_dir, metadata_path, skills.metadata_path, True)

    ffmpeg_path = shutil.which("ffmpeg")
    metadata["ffmpeg_path"] = ffmpeg_path or ""
    if not ffmpeg_path:
        metadata["status"] = "failed"
        metadata["reason"] = "ffmpeg not found"
        _write_metadata(metadata_path, metadata)
        return VideoRenderResult(fallback_video, composition_dir, metadata_path, skills.metadata_path, True)

    args = [*command, str(composition_dir), "--output", str(output_path)]
    use_shell = _requires_windows_shell(args)
    runner_args: list[str] | str = subprocess.list2cmdline(args) if use_shell else args
    metadata["command"] = args
    metadata["shell"] = use_shell
    if isinstance(runner_args, str):
        metadata["shell_command"] = runner_args
    try:
        completed = runner(runner_args, cwd=str(composition_dir), capture_output=True, text=True, timeout=600, shell=use_shell)
        metadata["returncode"] = completed.returncode
        metadata["stdout"] = completed.stdout[-4000:] if completed.stdout else ""
        metadata["stderr"] = completed.stderr[-4000:] if completed.stderr else ""
        if completed.returncode == 0 and output_path.exists():
            metadata["status"] = "completed"
            metadata["used_fallback"] = False
            metadata["video"] = str(output_path)
            _write_metadata(metadata_path, metadata)
            return VideoRenderResult(output_path, composition_dir, metadata_path, skills.metadata_path, False)
        metadata["status"] = "failed"
        metadata["reason"] = "command did not produce output video"
    except Exception as exc:  # noqa: BLE001 - optional external renderer.
        metadata["status"] = "failed"
        metadata["error"] = f"{type(exc).__name__}: {exc}"

    _write_metadata(metadata_path, metadata)
    return VideoRenderResult(fallback_video, composition_dir, metadata_path, skills.metadata_path, True)


def _write_hyperframes_composition(plan: dict[str, Any], package_dir: Path, preview_html: Path, fallback_video: Path) -> Path:
    composition_dir = package_dir / "hyperframes"
    composition_dir.mkdir(parents=True, exist_ok=True)
    source_video = Path(os.path.relpath(fallback_video, composition_dir)).as_posix()
    source_preview = Path(os.path.relpath(preview_html, composition_dir)).as_posix()
    slides = []
    for index, step in enumerate(plan.get("steps", []), start=1):
        slides.append(
            f"""
            <section class="scene" data-step-id="{_escape(str(step.get('id', index)))}">
              <p class="kicker">Step {index:02d}</p>
              <h2>{_escape(str(step.get('title', '단계')))}</h2>
              <p>{_escape(str(step.get('caption', '')))}</p>
            </section>
            """
        )
    html = f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=1920, height=1080" />
  <title>Manual Video Agent HyperFrames Composition</title>
  <style>
    body {{ margin: 0; width: 1920px; height: 1080px; overflow: hidden; font-family: Pretendard, Inter, system-ui, sans-serif; background: #f7f9fc; color: #050816; }}
    [data-composition-id] {{ width: 1920px; height: 1080px; display: grid; grid-template-columns: 1fr 440px; gap: 0; background: linear-gradient(135deg, #f8fbff, #eef4ff); }}
    .stage {{ position: relative; margin: 54px 0 54px 54px; border: 1px solid #d8e0ec; border-radius: 8px; overflow: hidden; background: #ffffff; box-shadow: 0 30px 86px rgba(17,24,39,.16); }}
    .manual-source-video {{ width: 100%; height: 100%; object-fit: cover; display: block; background: #ffffff; }}
    .manual-video-pointer {{ position: absolute; right: 116px; bottom: 108px; width: 28px; height: 28px; pointer-events: none; filter: drop-shadow(0 8px 16px rgba(17,24,39,.32)); }}
    .manual-video-pointer::before {{ content: ""; position: absolute; left: 0; top: 0; width: 0; height: 0; border-left: 22px solid #111827; border-top: 13px solid transparent; border-bottom: 13px solid transparent; transform: rotate(-34deg); transform-origin: 0 50%; }}
    .manual-video-pointer::after {{ content: ""; position: absolute; left: 14px; top: 14px; width: 10px; height: 10px; border-radius: 999px; background: #21d4fd; border: 2px solid #fff; box-shadow: 0 0 0 7px rgba(33,212,253,.18); }}
    aside {{ padding: 54px 42px; border-left: 1px solid #d8e0ec; display: flex; flex-direction: column; gap: 18px; }}
    aside .dot {{ width: 16px; height: 16px; border-radius: 999px; background: #21d4fd; box-shadow: 0 0 36px rgba(33,212,253,.72); }}
    aside h1 {{ margin: 14px 0 6px; font-size: 42px; line-height: 1.08; }}
    aside p {{ margin: 0; font-size: 18px; line-height: 1.5; color: #465161; }}
    .steps {{ display: grid; gap: 14px; margin-top: 10px; max-height: 730px; overflow: hidden; }}
    .scene {{ padding: 18px; border: 1px solid #d8e0ec; border-radius: 8px; background: rgba(255,255,255,.9); box-shadow: 0 16px 38px rgba(17,24,39,.07); }}
    .kicker {{ margin: 0 0 10px; color: #245bff; font-size: 13px; font-weight: 800; }}
    h2 {{ margin: 0 0 8px; font-size: 22px; line-height: 1.2; }}
    .scene p:last-child {{ margin: 0; font-size: 16px; line-height: 1.45; color: #465161; }}
  </style>
</head>
<body>
  <div data-composition-id="manual-video-agent" data-duration="18" data-fps="30">
    <div class="stage">
      <video class="manual-source-video" src="{_escape(source_video)}" muted autoplay loop playsinline></video>
      <div class="manual-video-pointer"></div>
    </div>
    <aside>
      <div class="dot"></div>
      <h1>Manual Video Agent</h1>
      <p>Playwright 녹화 영상을 HyperFrames composition의 1차 소스로 사용합니다.</p>
      <p>Source: {_escape(source_preview)}</p>
      <div class="steps">{''.join(slides)}</div>
    </aside>
  </div>
</body>
</html>"""
    (composition_dir / "index.html").write_text(html, encoding="utf-8")
    (composition_dir / "hyperframes_manifest.json").write_text(
        json.dumps(
            {
                "composition_id": "manual-video-agent",
                "source_preview": str(preview_html),
                "source_video": str(fallback_video),
                "source_video_relative": source_video,
                "steps": len(slides),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return composition_dir


def _split_command(command: str) -> list[str]:
    return shlex.split(command, posix=False)


def _requires_windows_shell(args: list[str]) -> bool:
    if os.name != "nt" or not args:
        return False
    suffix = Path(args[0]).suffix.lower()
    return suffix in {".cmd", ".bat"}


def _write_metadata(path: Path, metadata: dict[str, Any]) -> None:
    path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def _escape(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
