from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


@dataclass(frozen=True)
class MediaAssets:
    media_plan: dict[str, Any]
    media_plan_path: Path
    subtitles_path: Path


@dataclass(frozen=True)
class PreviewManualAssets:
    html_path: Path
    markdown_path: Path
    pdf_path: Path


def build_media_assets(
    *,
    request: Any,
    plan: dict[str, Any],
    action_log: list[dict[str, Any]],
    package_dir: Path,
    media_plan_func: Callable[[Any, dict[str, Any], list[dict[str, Any]]], dict[str, Any]],
    write_media_plan_func: Callable[[dict[str, Any], Path], Path],
    render_subtitles_func: Callable[[dict[str, Any], Path], Path],
) -> MediaAssets:
    media_plan = media_plan_func(request, plan, action_log)
    media_plan_path = write_media_plan_func(media_plan, package_dir)
    subtitles_path = render_subtitles_func(media_plan, package_dir)
    return MediaAssets(media_plan=media_plan, media_plan_path=media_plan_path, subtitles_path=subtitles_path)


def build_preview_manual_assets(
    *,
    request: Any,
    media_plan: dict[str, Any],
    dirs: Any,
    masked_names: list[str],
    tts_audio: list[Path],
    source_video: Path,
    subtitles_path: Path,
    settings: Any,
    render_preview_func: Callable[..., Path],
    render_markdown_func: Callable[[Any, dict[str, Any], Any, list[str], Any], Path],
    render_pdf_func: Callable[[Any, Any], Path],
) -> PreviewManualAssets:
    html_path = render_preview_func(
        request,
        media_plan,
        dirs,
        masked_names,
        tts_audio,
        source_video=source_video,
        subtitles_path=subtitles_path,
    )
    markdown_path = render_markdown_func(request, media_plan, dirs, masked_names, settings)
    pdf_path = render_pdf_func(request, dirs)
    return PreviewManualAssets(html_path=html_path, markdown_path=markdown_path, pdf_path=pdf_path)
