from __future__ import annotations

import importlib
import json
import os
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.config import AppSettings


SUPERTONIC_LICENSE = {
    "model": "Supertone/supertonic-3",
    "license": "BigScience Open RAIL-M License",
    "license_url": "https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE",
    "notice": "Generated audio must comply with OpenRAIL-M use restrictions.",
}
SUPERTONIC_VOICE_POLICY = {
    "allowed_voice_source": "preset",
    "custom_voice_allowed": False,
    "reason": "Internal manual videos use only bundled preset voices; custom voice cloning is not enabled.",
}
SUPERTONIC_AI_DISCLOSURE = "이 영상의 내레이션은 AI 음성 합성으로 생성되었습니다."


@dataclass(frozen=True)
class TtsResult:
    audio_paths: list[Path]
    metadata_path: Path
    entries: list[dict[str, Any]]


def synthesize_tts(plan: dict[str, Any], settings: AppSettings, tts_dir: Path) -> TtsResult:
    tts_dir.mkdir(parents=True, exist_ok=True)
    provider = settings.tts_provider.lower()
    use_melotts = provider in {"melotts", "melo", "melo-tts"}
    use_supertonic = provider in {"supertonic", "supertonic-3"}
    melotts_model = None
    melotts_speaker_id = None
    supertonic_model = None
    supertonic_style = None
    load_error = ""

    if use_supertonic:
        try:
            supertonic = importlib.import_module("supertonic")
            supertonic_model_dir = _supertonic_model_dir()
            supertonic_kwargs: dict[str, Any] = {"auto_download": settings.supertonic_auto_download}
            if supertonic_model_dir:
                supertonic_kwargs["model_dir"] = str(supertonic_model_dir)
            supertonic_model = supertonic.TTS(**supertonic_kwargs)
            supertonic_style = supertonic_model.get_voice_style(voice_name=settings.supertonic_voice)
        except Exception as exc:  # noqa: BLE001 - optional runtime dependency.
            load_error = f"{type(exc).__name__}: {exc}"
    elif use_melotts:
        try:
            melo_api = importlib.import_module("melo.api")
            melotts_model = melo_api.TTS(language=settings.tts_language, device=settings.tts_device)
            melotts_speaker_id = melotts_model.hps.data.spk2id[settings.tts_speaker]
        except Exception as exc:  # noqa: BLE001 - optional runtime dependency.
            load_error = f"{type(exc).__name__}: {exc}"

    audio_paths: list[Path] = []
    entries: list[dict[str, Any]] = []
    for index, step in enumerate(plan["steps"], start=1):
        text = str(step.get("narration") or step.get("caption") or step.get("title") or "")
        path = tts_dir / f"{index:02d}_{step['id']}.wav"
        provider_used = "silent-fallback"
        error = load_error
        language = settings.tts_language
        speaker = settings.tts_speaker
        voice_source = ""

        if supertonic_model is not None and supertonic_style is not None:
            try:
                wav, _duration = supertonic_model.synthesize(text, voice_style=supertonic_style, lang=settings.supertonic_lang)
                supertonic_model.save_audio(wav, str(path))
                provider_used = "supertonic"
                language = settings.supertonic_lang
                speaker = settings.supertonic_voice
                voice_source = "preset"
                error = ""
            except Exception as exc:  # noqa: BLE001 - keep the manual package build alive.
                language = settings.supertonic_lang
                speaker = settings.supertonic_voice
                voice_source = "preset"
                error = f"{type(exc).__name__}: {exc}"
                _write_silent_wav(path, duration_seconds=max(1.2, len(text) / 18))
        elif melotts_model is not None and melotts_speaker_id is not None:
            try:
                melotts_model.tts_to_file(text, melotts_speaker_id, str(path), speed=settings.tts_speed)
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
                "language": language,
                "speaker": speaker,
                "voice_source": voice_source,
                "device": settings.tts_device,
                "speed": settings.tts_speed,
                "text": text,
                "audio": str(path),
                "error": error,
            }
        )

    metadata_path = tts_dir / "tts_metadata.json"
    metadata: dict[str, Any] = {"status": "completed", "requested_provider": settings.tts_provider, "entries": entries}
    if use_supertonic:
        metadata["ai_voice_disclosure"] = SUPERTONIC_AI_DISCLOSURE
        metadata["license"] = SUPERTONIC_LICENSE
        metadata["voice_policy"] = SUPERTONIC_VOICE_POLICY
        metadata["runtime"] = _supertonic_runtime_metadata()
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    return TtsResult(audio_paths=audio_paths, metadata_path=metadata_path, entries=entries)


def _supertonic_model_dir() -> Path | None:
    configured = os.environ.get("SUPERTONIC_CACHE_DIR", "").strip()
    return Path(configured).expanduser() if configured else None


def _supertonic_runtime_metadata() -> dict[str, str | bool]:
    model_dir = _supertonic_model_dir()
    hf_home = os.environ.get("HF_HOME", "").strip()
    return {
        "supertonic_cache_dir": str(model_dir) if model_dir else "",
        "supertonic_cache_dir_exists": bool(model_dir and model_dir.exists()),
        "hf_home": hf_home,
        "hf_home_exists": bool(hf_home and Path(hf_home).expanduser().exists()),
    }


def _write_silent_wav(path: Path, duration_seconds: float) -> None:
    sample_rate = 16000
    frames = int(sample_rate * duration_seconds)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\x00\x00" * frames)
