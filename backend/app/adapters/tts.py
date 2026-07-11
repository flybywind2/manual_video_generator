from __future__ import annotations

import importlib
import json
import os
import re
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, NoReturn

from backend.app.config import AppSettings


SUPERTONIC_PROVIDER = "supertonic"
SUPERTONIC_VOICE = "M1"
SUPERTONIC_LANGUAGE = "ko"
SUPERTONIC_LICENSE = {
    "model": "Supertone/supertonic-3",
    "license": "BigScience Open RAIL-M License",
    "license_url": "https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE",
    "notice": "Generated audio must comply with OpenRAIL-M use restrictions.",
}
SUPERTONIC_VOICE_POLICY = {
    "allowed_voice_source": "preset",
    "custom_voice_allowed": False,
    "preset_voice": SUPERTONIC_VOICE,
    "reason": "Internal manual videos use only the bundled M1 preset voice; custom voice cloning is disabled.",
}
SUPERTONIC_AI_DISCLOSURE = "이 영상의 내레이션은 AI 음성 합성으로 생성되었습니다."


class SupertonicTtsError(RuntimeError):
    def __init__(self, code: str, message: str, *, step_id: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.step_id = step_id


@dataclass(frozen=True)
class TtsResult:
    audio_paths: list[Path]
    metadata_path: Path
    entries: list[dict[str, Any]]


def synthesize_tts(
    plan: dict[str, Any],
    settings: AppSettings,
    tts_dir: Path,
    *,
    module_loader: Callable[[str], Any] | None = None,
) -> TtsResult:
    tts_dir.mkdir(parents=True, exist_ok=True)
    _clean_tts_dir(tts_dir)
    if settings.tts_provider.strip().lower() != SUPERTONIC_PROVIDER:
        _fail(
            tts_dir,
            "unsupported_tts_provider",
            "Supertonic is the only supported TTS provider",
        )

    steps = plan.get("steps")
    if not isinstance(steps, list) or not steps:
        _fail(tts_dir, "tts_plan_empty", "TTS plan must contain at least one narration step")

    loader = module_loader or importlib.import_module
    try:
        supertonic = loader("supertonic")
    except Exception as exc:
        _fail(
            tts_dir,
            "supertonic_import_failed",
            f"Supertonic could not be imported: {type(exc).__name__}: {exc}",
            cause=exc,
        )

    model_dir = _supertonic_model_dir(settings)
    model_kwargs: dict[str, Any] = {"auto_download": settings.supertonic_auto_download}
    if model_dir is not None:
        model_kwargs["model_dir"] = str(model_dir)
    try:
        model = supertonic.TTS(**model_kwargs)
    except Exception as exc:
        _fail(
            tts_dir,
            "supertonic_model_load_failed",
            f"Supertonic model initialization failed: {type(exc).__name__}: {exc}",
            cause=exc,
        )
    try:
        voice_style = model.get_voice_style(voice_name=SUPERTONIC_VOICE)
    except Exception as exc:
        _fail(
            tts_dir,
            "supertonic_style_failed",
            f"Supertonic M1 voice style could not be loaded: {type(exc).__name__}: {exc}",
            cause=exc,
        )

    audio_paths: list[Path] = []
    entries: list[dict[str, Any]] = []
    for index, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            _fail(tts_dir, "tts_step_invalid", "TTS plan contains a non-object step")
        step_id = str(step.get("id") or f"step-{index}")
        text = _narration_text_for_step(step)
        if not text:
            _fail(
                tts_dir,
                "tts_narration_empty",
                f"Narration is empty for step {step_id}",
                step_id=step_id,
            )
        path = tts_dir / f"{index:02d}_{_safe_step_id(step_id)}.wav"
        try:
            synthesized = model.synthesize(
                text,
                voice_style=voice_style,
                lang=SUPERTONIC_LANGUAGE,
            )
            wav, reported_duration = synthesized
        except Exception as exc:
            _fail(
                tts_dir,
                "supertonic_synthesis_failed",
                f"Supertonic synthesis failed for step {step_id}: {type(exc).__name__}: {exc}",
                step_id=step_id,
                cause=exc,
            )
        if not _audio_payload_nonempty(wav):
            _fail(
                tts_dir,
                "supertonic_audio_invalid",
                f"Supertonic returned empty audio for step {step_id}",
                step_id=step_id,
            )
        try:
            model.save_audio(wav, str(path))
        except Exception as exc:
            _fail(
                tts_dir,
                "supertonic_save_failed",
                f"Supertonic audio save failed for step {step_id}: {type(exc).__name__}: {exc}",
                step_id=step_id,
                cause=exc,
            )
        if not _valid_wav(path):
            _fail(
                tts_dir,
                "supertonic_audio_invalid",
                f"Supertonic produced an empty or invalid WAV for step {step_id}",
                step_id=step_id,
            )

        text_path = path.with_suffix(".txt")
        text_path.write_text(text, encoding="utf-8")
        duration = _positive_float(reported_duration) or _wav_duration(path)
        audio_paths.append(path)
        entries.append(
            {
                "step_id": step_id,
                "provider": SUPERTONIC_PROVIDER,
                "language": SUPERTONIC_LANGUAGE,
                "speaker": SUPERTONIC_VOICE,
                "voice_source": "preset",
                "text": text,
                "audio": str(path),
                "duration_seconds": round(duration, 4),
                "error": "",
            }
        )

    metadata_path = tts_dir / "tts_metadata.json"
    metadata = {
        "status": "completed",
        "requested_provider": SUPERTONIC_PROVIDER,
        "entries": entries,
        "ai_voice_disclosure": SUPERTONIC_AI_DISCLOSURE,
        "license": SUPERTONIC_LICENSE,
        "voice_policy": SUPERTONIC_VOICE_POLICY,
        "runtime": _supertonic_runtime_metadata(model_dir),
    }
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    return TtsResult(audio_paths=audio_paths, metadata_path=metadata_path, entries=entries)


def _fail(
    tts_dir: Path,
    code: str,
    message: str,
    *,
    step_id: str = "",
    cause: Exception | None = None,
) -> NoReturn:
    _clean_tts_dir(tts_dir)
    error = SupertonicTtsError(code, message, step_id=step_id)
    if cause is not None:
        raise error from cause
    raise error


def _clean_tts_dir(tts_dir: Path) -> None:
    for pattern in ("*.wav", "*.txt", "tts_metadata.json"):
        for path in tts_dir.glob(pattern):
            if path.is_file():
                path.unlink()


def _supertonic_model_dir(settings: AppSettings | None = None) -> Path | None:
    candidates: list[Path] = []
    configured = str(getattr(settings, "supertonic_cache_dir", "") or "").strip()
    if not configured:
        configured = os.environ.get("SUPERTONIC_CACHE_DIR", "").strip()
    if configured:
        candidates.append(Path(configured).expanduser())
    bundle_root = os.environ.get("MANUAL_AGENT_BUNDLE_ROOT", "").strip()
    if bundle_root:
        candidates.append(Path(bundle_root).expanduser() / "runtime" / "supertonic3")
    candidates.extend(
        [
            Path.cwd() / "runtime" / "supertonic3",
            Path.home() / ".cache" / "supertonic3",
        ]
    )
    for candidate in candidates:
        if _has_supertonic_onnx(candidate):
            return candidate.resolve()
    return candidates[0].resolve() if candidates else None


def _narration_text_for_step(step: dict[str, Any]) -> str:
    return str(step.get("narration") or step.get("caption") or step.get("title") or "").strip()


def _safe_step_id(step_id: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", step_id).strip("-.")
    return value or "step"


def _audio_payload_nonempty(value: Any) -> bool:
    if value is None:
        return False
    size = getattr(value, "size", None)
    if size is not None:
        try:
            return int(size) > 0
        except (TypeError, ValueError):
            pass
    try:
        return len(value) > 0
    except TypeError:
        return True


def _valid_wav(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size <= 44:
        return False
    try:
        with wave.open(str(path), "rb") as audio:
            return audio.getnchannels() > 0 and audio.getframerate() > 0 and audio.getnframes() > 0
    except (OSError, EOFError, wave.Error):
        return False


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / max(1, audio.getframerate())


def _positive_float(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0.0
    return parsed if parsed > 0 else 0.0


def _has_supertonic_onnx(path: Path) -> bool:
    onnx_dir = path / "onnx"
    required = {"duration_predictor.onnx", "text_encoder.onnx", "vector_estimator.onnx", "vocoder.onnx"}
    return onnx_dir.exists() and all((onnx_dir / name).exists() for name in required)


def _supertonic_runtime_metadata(model_dir: Path | None) -> dict[str, str | bool]:
    hf_home = os.environ.get("HF_HOME", "").strip()
    return {
        "supertonic_cache_dir": str(model_dir) if model_dir else "",
        "supertonic_cache_dir_exists": bool(model_dir and model_dir.exists()),
        "supertonic_onnx_exists": bool(model_dir and _has_supertonic_onnx(model_dir)),
        "hf_home": hf_home,
        "hf_home_exists": bool(hf_home and Path(hf_home).expanduser().exists()),
    }
