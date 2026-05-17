import json
from pathlib import Path

from backend.app.adapters.planner import build_plan
from backend.app.adapters.tts import synthesize_tts
from backend.app.adapters.video import render_final_video
from backend.app.config import load_settings
from backend.app.pipeline import PipelineInput


def test_internal_planner_uses_llm_json_when_enabled(tmp_path: Path):
    request = PipelineInput(
        request_text="MES에서 LOT 조회 방법 영상 만들기",
        target_url="http://127.0.0.1:8000/sample",
        role="작업자",
        completion_condition="상세 화면이 보이면 완료",
        input_values={"LOT": "LOT-001"},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_INTERNAL_PLANNER": "true",
            "MANUAL_AGENT_OPENAI_API_KEY": "local-api-key",
            "MANUAL_AGENT_LLM_BASE_URL": "http://api.net:8000/v1",
            "MANUAL_AGENT_LLM_MODEL": "QWEN3",
            "MANUAL_AGENT_DEP_TICKET": "credential:TICKET-123",
            "MANUAL_AGENT_SEND_SYSTEM_NAME": "manual-video-agent",
            "MANUAL_AGENT_USER_ID": "USER01",
            "MANUAL_AGENT_USER_TYPE": "AD_ID",
        }
    )
    calls = []

    def fake_post(url, headers, payload, timeout_seconds):
        calls.append({"url": url, "headers": headers, "payload": payload, "timeout": timeout_seconds})
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "steps": [
                                    {
                                        "id": "step_custom",
                                        "title": "LLM 생성 단계",
                                        "caption": "LLM이 생성한 설명입니다.",
                                        "narration": "LLM이 생성한 내레이션입니다.",
                                    }
                                ],
                                "actions": [
                                    {
                                        "id": "a1",
                                        "type": "navigate",
                                        "target": "http://127.0.0.1:8000/sample",
                                        "step_id": "step_custom",
                                    }
                                ],
                            },
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }

    plan = build_plan(request, settings, package_dir=tmp_path, http_post=fake_post)

    assert plan["source"] == "internal-llm-planner"
    assert plan["steps"][0]["title"] == "LLM 생성 단계"
    assert plan["actions"][0]["type"] == "navigate"
    assert calls[0]["url"] == "http://api.net:8000/v1/chat/completions"
    assert calls[0]["payload"]["model"] == "QWEN3"
    assert "Authorization" in calls[0]["headers"]


def test_melotts_provider_falls_back_to_silent_wav_when_library_is_missing(tmp_path: Path):
    settings = load_settings(environ={"MANUAL_AGENT_TTS_PROVIDER": "melotts"})
    plan = {
        "steps": [
            {
                "id": "step_intro",
                "title": "요청 확인",
                "caption": "요청을 확인합니다.",
                "narration": "요청을 확인합니다.",
            }
        ]
    }

    result = synthesize_tts(plan, settings, tmp_path)

    assert result.audio_paths[0].exists()
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["status"] == "completed"
    assert metadata["entries"][0]["provider"] in {"melotts", "silent-fallback"}
    assert metadata["entries"][0]["text"] == "요청을 확인합니다."


def test_hyperframes_render_creates_composition_and_keeps_fallback_video(tmp_path: Path):
    settings = load_settings(
        environ={
            "MANUAL_AGENT_VIDEO_RENDERER": "hyperframes",
            "MANUAL_AGENT_HYPERFRAMES_COMMAND": "missing-hyperframes-command",
        }
    )
    preview = tmp_path / "preview.html"
    preview.write_text("<html><body>preview</body></html>", encoding="utf-8")
    fallback_video = tmp_path / "manual_video_agent_usage.webm"
    fallback_video.write_bytes(b"webm")
    plan = {
        "steps": [
            {
                "id": "step_intro",
                "title": "요청 확인",
                "caption": "요청을 확인합니다.",
                "narration": "요청을 확인합니다.",
            }
        ]
    }

    result = render_final_video(
        plan=plan,
        package_dir=tmp_path,
        preview_html=preview,
        fallback_video=fallback_video,
        settings=settings,
        command_runner=lambda *args, **kwargs: (_ for _ in ()).throw(FileNotFoundError("missing")),
    )

    assert result.video_path == fallback_video
    assert result.composition_dir.joinpath("index.html").exists()
    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["renderer"] == "hyperframes"
    assert metadata["fallback_video"] == str(fallback_video)
    assert metadata["used_fallback"] is True
