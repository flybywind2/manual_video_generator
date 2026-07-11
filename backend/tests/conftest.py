from __future__ import annotations

import sys
import wave
from pathlib import Path
from types import SimpleNamespace

import pytest


class _TestAudio:
    def __init__(self, duration_seconds: float) -> None:
        self.duration_seconds = duration_seconds
        self.size = max(1, int(16000 * duration_seconds))

    def __len__(self) -> int:
        return self.size


class _TestSupertonicTts:
    def __init__(self, **_kwargs) -> None:
        pass

    def get_voice_style(self, *, voice_name: str):
        return {"preset": voice_name}

    def synthesize(self, text: str, *, voice_style, lang: str):
        duration = max(1.2, len(text) / 18.0)
        return _TestAudio(duration), duration

    def save_audio(self, audio: _TestAudio, path: str) -> None:
        sample_rate = 16000
        frame_count = max(1, int(sample_rate * audio.duration_seconds))
        with wave.open(str(Path(path)), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            output.writeframes(b"\x01\x00" * frame_count)


@pytest.fixture(autouse=True)
def _fake_supertonic_runtime(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setitem(sys.modules, "supertonic", SimpleNamespace(TTS=_TestSupertonicTts))
