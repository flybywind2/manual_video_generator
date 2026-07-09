from types import SimpleNamespace

from backend.app.adapters.page_agent import decide_page_agent_action, enrich_page_agent_observation
from backend.app.adapters.browser_agent import decide_browser_agent_action
from backend.app.config import load_settings


def test_page_agent_setting_is_exposed_in_status():
    settings = load_settings(environ={"MANUAL_AGENT_ENABLE_PAGE_AGENT": "true"})

    assert settings.enable_page_agent is True
    assert settings.safe_status()["runtime"]["enable_page_agent"] is True


def test_page_agent_prefers_selector_for_textless_icon_click():
    request = SimpleNamespace(
        request_text="더하기 아이콘을 눌러 모달창을 확인하고 닫아줘",
        input_values={},
        agent_brief={"safe_click_intents": ["더하기", "닫기"]},
    )
    observation = {
        "fields": [],
        "clickables": [
            {
                "selector": "i.icon.icon-plus-bold",
                "text": "",
                "title": "",
                "aria": "",
                "class_name": "icon icon-plus-bold",
                "agent_name": "더하기",
                "agent_role": "button",
            }
        ],
        "body_text": "목록 화면",
    }

    action = decide_page_agent_action(request, observation, [], step_index=1)

    assert action == {
        "status": "ok",
        "source": "page-agent-dom",
        "type": "click_by_selector",
        "selector": "i.icon.icon-plus-bold",
        "selector_source": "page_agent.clickables",
        "reason": "더하기 요소를 selector로 선택합니다.",
    }


def test_page_agent_enriches_clickable_name_from_icon_class():
    observation = {
        "clickables": [
            {
                "selector": "i.icon.icon-plus-bold",
                "text": "",
                "title": "",
                "aria": "",
                "class_name": "icon icon-plus-bold",
                "role": "i",
            }
        ],
        "fields": [],
    }

    enriched = enrich_page_agent_observation(observation)

    assert enriched["page_agent"]["status"] == "ok"
    assert enriched["clickables"][0]["agent_name"] == "더하기"
    assert enriched["clickables"][0]["agent_role"] == "button"


def test_browser_agent_uses_page_agent_before_llm_when_enabled(tmp_path):
    request = SimpleNamespace(
        request_text="더하기 버튼을 눌러 모달을 확인해줘",
        target_url="http://internal.example.local",
        role="사용자",
        completion_condition="모달 확인",
        input_values={},
        agent_brief={"safe_click_intents": ["더하기"]},
    )
    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENABLE_BROWSER_AGENT": "true",
            "MANUAL_AGENT_ENABLE_PAGE_AGENT": "true",
            "MANUAL_AGENT_LLM_PROVIDER": "ollama",
            "MANUAL_AGENT_LLM_BASE_URL": "http://127.0.0.1:11434/v1",
            "MANUAL_AGENT_LLM_MODEL": "qwen3.5",
        }
    )

    def fail_if_llm_called(*_args, **_kwargs):
        raise AssertionError("page-agent DOM candidate should short-circuit LLM")

    action = decide_browser_agent_action(
        request,
        settings,
        {
            "fields": [],
            "clickables": [{"selector": "i.icon.icon-plus-bold", "class_name": "icon icon-plus-bold"}],
            "body_text": "목록",
        },
        [],
        step_index=1,
        http_post=fail_if_llm_called,
        package_dir=tmp_path,
    )

    assert action["type"] == "click_by_selector"
    assert action["source"] == "page-agent-dom"
    assert action["selector"] == "i.icon.icon-plus-bold"
