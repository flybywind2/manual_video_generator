from __future__ import annotations

from pathlib import Path
from typing import Any


def build_artifact_dependencies(*, package_dir: Path, artifacts: Any) -> dict[str, dict[str, list[str]]]:
    def rel(path: Path | None) -> str:
        if path is None:
            return ""
        try:
            return path.relative_to(package_dir).as_posix()
        except ValueError:
            return str(path)

    manual = rel(getattr(artifacts, "markdown_manual", None))
    subtitles = rel(getattr(artifacts, "subtitles", None))
    media_plan = rel(getattr(artifacts, "media_plan", None))
    tts_metadata = rel(getattr(artifacts, "tts_metadata", None))
    preview = rel(getattr(artifacts, "html_preview", None))
    video = rel(getattr(artifacts, "video", None))

    graph = {
        manual: {"regenerates": [preview, video], "preserves": ["captures", "masking_log"]},
        subtitles: {"regenerates": [tts_metadata, preview, video], "preserves": ["captures", "masking_log"]},
        media_plan: {"regenerates": [subtitles, tts_metadata, preview, video], "preserves": ["captures", "masking_log"]},
        tts_metadata: {"regenerates": [preview, video], "preserves": ["captures", "masking_log"]},
    }
    return {key: value for key, value in graph.items() if key}
