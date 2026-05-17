from __future__ import annotations

import importlib
import json
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.config import AppSettings


@dataclass(frozen=True)
class TtsResult:
    audio_paths: list[Path]
    metadata_path: Path
    entries: list[dict[str, Any]]


def synthesize_tts(plan: dict[str, Any], settings: AppSettings, tts_dir: Path) -> TtsResult:
    tts_dir.mkdir(parents=True, exist_ok=True)
    provider = settings.tts_provider.lower()
    use_melotts = provider in {"melotts", "melo", "melo-tts"}
    model = None
    speaker_id = None
    load_error = ""

    if use_melotts:
        try:
            melo_api = importlib.import_module("melo.api")
            model = melo_api.TTS(language=settings.tts_language, device=settings.tts_device)
            speaker_id = model.hps.data.spk2id[settings.tts_speaker]
        except Exception as exc:  # noqa: BLE001 - optional runtime dependency.
            load_error = f"{type(exc).__name__}: {exc}"

    audio_paths: list[Path] = []
    entries: list[dict[str, Any]] = []
    for index, step in enumerate(plan["steps"], start=1):
        text = str(step.get("narration") or step.get("caption") or step.get("title") or "")
        path = tts_dir / f"{index:02d}_{step['id']}.wav"
        provider_used = "silent-fallback"
        error = load_error

        if model is not None and speaker_id is not None:
            try:
                model.tts_to_file(text, speaker_id, str(path), speed=settings.tts_speed)
                provider_used = "melotts"
                error = ""
            except Exception as exc:  # noqa: BLE001 - keep the manual package build alive.
                error = f"{type(exc).__name__}: {exc}"
                _write_silent_wav(path, duration_seconds=max(1.2, len(text) / 18))
        else:
            _write_silent_wav(path, duration_seconds=max(1.2, len(text) / 18))

        path.with_suffix(".txt").write_text(text, encoding="utf-8")
        audio_paths.append(path)
        entries.append(
            {
                "step_id": step["id"],
                "provider": provider_used,
                "language": settings.tts_language,
                "speaker": settings.tts_speaker,
                "device": settings.tts_device,
                "speed": settings.tts_speed,
                "text": text,
                "audio": str(path),
                "error": error,
            }
        )

    metadata_path = tts_dir / "tts_metadata.json"
    metadata_path.write_text(
        json.dumps({"status": "completed", "requested_provider": settings.tts_provider, "entries": entries}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return TtsResult(audio_paths=audio_paths, metadata_path=metadata_path, entries=entries)


def _write_silent_wav(path: Path, duration_seconds: float) -> None:
    sample_rate = 16000
    frames = int(sample_rate * duration_seconds)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\x00\x00" * frames)
