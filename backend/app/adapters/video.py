from __future__ import annotations

import json
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
    composition_dir = _write_hyperframes_composition(plan, package_dir, preview_html)
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

    args = [*command, str(composition_dir / "index.html"), "--output", str(output_path)]
    metadata["command"] = args
    try:
        completed = runner(args, cwd=str(composition_dir), capture_output=True, text=True, timeout=600)
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


def _write_hyperframes_composition(plan: dict[str, Any], package_dir: Path, preview_html: Path) -> Path:
    composition_dir = package_dir / "hyperframes"
    composition_dir.mkdir(parents=True, exist_ok=True)
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
    [data-composition-id] {{ width: 1920px; height: 1080px; display: grid; grid-template-columns: 520px 1fr; background: radial-gradient(circle at 12% 18%, rgba(33,212,253,.28), transparent 28%), linear-gradient(135deg, #f7f9fc, #eef3ff); }}
    aside {{ padding: 72px; border-right: 1px solid #d8e0ec; }}
    aside .dot {{ width: 18px; height: 18px; border-radius: 999px; background: #21d4fd; box-shadow: 0 0 42px rgba(33,212,253,.72); }}
    aside h1 {{ margin: 28px 0 18px; font-size: 58px; line-height: 1.08; }}
    aside p {{ font-size: 24px; line-height: 1.45; color: #465161; }}
    main {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; padding: 72px; align-content: center; }}
    .scene {{ min-height: 300px; padding: 34px; border: 1px solid #d8e0ec; border-radius: 8px; background: rgba(255,255,255,.86); box-shadow: 0 24px 70px rgba(17,24,39,.08); }}
    .kicker {{ margin: 0 0 20px; color: #245bff; font-size: 18px; font-weight: 800; }}
    h2 {{ margin: 0 0 18px; font-size: 38px; line-height: 1.2; }}
    .scene p:last-child {{ font-size: 22px; line-height: 1.55; color: #465161; }}
  </style>
</head>
<body>
  <div data-composition-id="manual-video-agent" data-duration="18" data-fps="30">
    <aside>
      <div class="dot"></div>
      <h1>Manual Video Agent</h1>
      <p>HTML preview를 기반으로 운영용 HyperFrames 렌더링으로 교체 가능한 composition입니다.</p>
      <p>Source: {_escape(preview_html.name)}</p>
    </aside>
    <main>{''.join(slides)}</main>
  </div>
</body>
</html>"""
    (composition_dir / "index.html").write_text(html, encoding="utf-8")
    (composition_dir / "hyperframes_manifest.json").write_text(
        json.dumps({"composition_id": "manual-video-agent", "source_preview": str(preview_html), "steps": len(slides)}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return composition_dir


def _split_command(command: str) -> list[str]:
    return shlex.split(command, posix=False)


def _write_metadata(path: Path, metadata: dict[str, Any]) -> None:
    path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def _escape(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
