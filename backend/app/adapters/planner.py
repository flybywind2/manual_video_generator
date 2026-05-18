from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from backend.app.action_safety import click_text_candidates, is_disallowed_click_texts
from backend.app.config import AppSettings
from backend.app.llm_logging import record_llm_response


HttpPost = Callable[[str, dict[str, str], dict[str, Any], float], dict[str, Any]]


def build_plan(
    request: Any,
    settings: AppSettings,
    *,
    package_dir: Path | None = None,
    http_post: HttpPost | None = None,
) -> dict[str, Any]:
    if not settings.enable_internal_planner or not settings.llm.is_configured:
        trace = {
            "planner": "local-deterministic",
            "rag": {"status": "skipped"},
            "reranker": {"status": "skipped"},
            "reason": "internal planner disabled or llm not configured",
        }
        _write_trace(package_dir, trace)
        plan = deterministic_plan(request, settings.safe_status())
        plan["planner_trace"] = trace
        return plan

    post = post_json if http_post is None else http_post
    trace: dict[str, Any] = {"planner": "internal-llm", "rag": None, "reranker": None}
    try:
        context_docs = _retrieve_context(request, settings, post, trace)
        plan = _call_llm_planner(request, settings, context_docs, post, package_dir=package_dir)
        plan["source"] = "internal-llm-planner"
        plan["config_status"] = settings.safe_status()
        plan["planner_trace"] = trace
        _write_trace(package_dir, trace)
        return plan
    except Exception as exc:  # noqa: BLE001 - fallback must keep the operator flow alive.
        fallback = deterministic_plan(request, settings.safe_status())
        fallback["source"] = "local-deterministic-planner-fallback"
        fallback["planner_error"] = f"{type(exc).__name__}: {exc}"
        trace["error"] = fallback["planner_error"]
        _write_trace(package_dir, trace)
        return fallback


def deterministic_plan(request: Any, config_status: dict[str, object] | None = None) -> dict[str, Any]:
    input_summary = _format_input_summary(request.input_values)
    actions = _deterministic_actions(request)
    return {
        "source": "local-deterministic-planner",
        "config_status": config_status or {},
        "steps": [
            {
                "id": "step_intro",
                "title": "대상 화면 진입",
                "caption": "입력된 대상 URL로 이동해 화면 상태를 확인합니다.",
                "narration": "입력된 대상 URL로 이동해 화면 상태를 확인합니다.",
            },
            {
                "id": "step_inputs",
                "title": "입력 조건 확인",
                "caption": f"시나리오에 필요한 입력 조건을 확인합니다. {input_summary}",
                "narration": f"시나리오에 필요한 입력 조건을 확인합니다. {input_summary}",
            },
            {
                "id": "step_completion",
                "title": "완료 조건 확인",
                "caption": f"완료 조건을 기준으로 화면을 검수합니다. {request.completion_condition}",
                "narration": f"완료 조건을 기준으로 화면을 검수합니다. {request.completion_condition}",
            },
            {
                "id": "step_export",
                "title": "산출물 생성",
                "caption": "캡처, 마스킹, 내레이션, 문서와 영상을 패키징합니다.",
                "narration": "캡처, 마스킹, 내레이션, 문서와 영상을 패키징합니다.",
            },
        ],
        "actions": actions,
    }


def _deterministic_actions(request: Any) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = [
        {"id": "a1", "type": "navigate", "target": request.target_url, "step_id": "step_intro"},
        {"id": "a2", "type": "capture_step", "step_id": "step_intro"},
    ]
    next_id = 3
    for key, value in request.input_values.items():
        actions.append(
            {
                "id": f"a{next_id}",
                "type": "fill_by_label",
                "label": str(key),
                "value": str(value),
                "step_id": "step_inputs",
            }
        )
        next_id += 1
    actions.append({"id": f"a{next_id}", "type": "capture_step", "step_id": "step_inputs"})
    next_id += 1

    for index, texts in enumerate(_infer_safe_click_text_groups(request), start=1):
        step_id = "step_completion" if any("상세" in text for text in texts) else "step_inputs"
        actions.append(
            {
                "id": f"a{next_id}",
                "type": "click_by_text",
                "label": texts[0],
                "texts": texts,
                "step_id": step_id,
            }
        )
        next_id += 1
        actions.append({"id": f"a{next_id}", "type": "capture_step", "step_id": step_id})
        next_id += 1

    if not any(action["type"] == "capture_step" and action["step_id"] == "step_completion" for action in actions):
        actions.append({"id": f"a{next_id}", "type": "capture_step", "step_id": "step_completion"})
        next_id += 1

    actions.append(
        {
            "id": f"a{next_id}",
            "type": "danger_approval",
            "label": "렌더링 확정",
            "requires_approval": True,
            "step_id": "step_export",
            "danger": {"is_danger": True, "reasons": ["keyword:확정"]},
        }
    )
    return actions


def _infer_safe_click_text_groups(request: Any) -> list[list[str]]:
    text = f"{request.request_text} {request.completion_condition}"
    groups: list[list[str]] = []
    if "조회" in text:
        groups.append(["조회", "검색"])
    elif "검색" in text:
        groups.append(["검색", "조회"])
    if "상세" in text:
        groups.append(["상세 보기", "상세", "Detail", "Details"])
    return groups


def _format_input_summary(input_values: dict[str, Any]) -> str:
    if not input_values:
        return "추가 입력값은 없습니다."
    rendered = ", ".join(f"{key}={value}" for key, value in input_values.items())
    return f"입력값: {rendered}"


def post_json(url: str, headers: dict[str, str], payload: dict[str, Any], timeout_seconds: float) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc


def _retrieve_context(
    request: Any,
    settings: AppSettings,
    post: HttpPost,
    trace: dict[str, Any],
) -> list[str]:
    if not settings.enable_rag_context or not settings.rag.is_configured:
        trace["rag"] = {"status": "skipped"}
        trace["reranker"] = {"status": "skipped", "reason": "rag_context_skipped"}
        return []

    payload = {
        "index_name": settings.rag.index_name,
        "permission_groups": settings.rag.permission_groups,
        "query_text": request.request_text,
        "num_result_doc": 5,
        "fields_exclude": ["v_merge_title_content"],
    }
    headers = {
        "Content-Type": "application/json",
        "x-dep-ticket": settings.rag.dep_ticket,
        "api-key": settings.rag.api_key,
    }
    response = post(settings.rag.retrieve_url, headers, payload, settings.request_timeout_seconds)
    docs = _extract_documents(response)
    trace["rag"] = {"status": "called", "documents": len(docs)}

    if settings.enable_reranker and settings.reranker.is_configured and docs:
        docs = _rerank_documents(request.request_text, docs, settings, post, trace)
    return docs


def _rerank_documents(
    query: str,
    documents: list[str],
    settings: AppSettings,
    post: HttpPost,
    trace: dict[str, Any],
) -> list[str]:
    payload = {"model": settings.reranker.model, "query": query, "documents": documents, "top_n": min(5, len(documents))}
    headers = {"Content-Type": "application/json", "X-DEP-TICKET": settings.reranker.dep_ticket}
    response = post(settings.reranker.url, headers, payload, settings.request_timeout_seconds)
    reranked = _extract_documents(response) or documents
    trace["reranker"] = {"status": "called", "documents": len(reranked)}
    return reranked


def _call_llm_planner(
    request: Any,
    settings: AppSettings,
    context_docs: list[str],
    post: HttpPost,
    *,
    package_dir: Path | None,
) -> dict[str, Any]:
    url = f"{settings.llm.base_url.rstrip('/')}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.llm.api_key}",
        **settings.llm.default_headers(),
    }
    payload = {
        "model": settings.llm.model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "너는 사내 시스템 사용 매뉴얼 영상 제작용 action plan을 생성한다. "
                    "반드시 JSON만 반환한다. JSON schema: "
                    "{steps:[{id,title,caption,narration}], actions:[{id,type,step_id,selector?,target?,value?,requires_approval?}]}. "
                    "웹 검색, web search, 모델 선택, 도구 선택, 기능 토글 같은 선택형 UI는 클릭하지 않는다."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "request_text": request.request_text,
                        "target_url": request.target_url,
                        "role": request.role,
                        "completion_condition": request.completion_condition,
                        "input_values": request.input_values,
                        "rag_context": context_docs,
                    },
                    ensure_ascii=False,
                ),
            },
        ],
        "temperature": 0.2,
        "extra_body": {"chat_template_kwargs": {"enable_thinking": False}},
    }
    response = post(url, headers, payload, settings.llm_timeout_seconds)
    content = response["choices"][0]["message"]["content"]
    record_llm_response(
        component="planner",
        model=settings.llm.model,
        response=response,
        content=content,
        terminal_enabled=settings.enable_terminal_logs,
        package_dir=package_dir,
    )
    return _normalize_plan(_parse_json_content(content), request)


def _normalize_plan(data: dict[str, Any], request: Any) -> dict[str, Any]:
    steps = data.get("steps")
    actions = data.get("actions")
    if not isinstance(steps, list) or not steps:
        raise ValueError("planner response must contain non-empty steps")
    if not isinstance(actions, list) or not actions:
        raise ValueError("planner response must contain non-empty actions")

    normalized_steps = []
    for index, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            raise ValueError("planner step must be an object")
        step_id = str(step.get("id") or f"step_{index}")
        title = str(step.get("title") or f"단계 {index}")
        caption = str(step.get("caption") or title)
        narration = str(step.get("narration") or caption)
        normalized_steps.append({"id": step_id, "title": title, "caption": caption, "narration": narration})

    normalized_actions = []
    for index, action in enumerate(actions, start=1):
        if not isinstance(action, dict):
            raise ValueError("planner action must be an object")
        item = dict(action)
        item["id"] = str(item.get("id") or f"a{index}")
        item["type"] = str(item.get("type") or "capture_step")
        item["step_id"] = str(item.get("step_id") or normalized_steps[min(index - 1, len(normalized_steps) - 1)]["id"])
        if item["type"] == "click_by_text" and is_disallowed_click_texts(click_text_candidates(item)):
            item = {
                "id": item["id"],
                "type": "capture_step",
                "step_id": item["step_id"],
                "reason": "blocked_disallowed_click_text",
            }
        normalized_actions.append(item)

    if not any(action["type"] == "navigate" for action in normalized_actions):
        normalized_actions.insert(
            0,
            {"id": "a0", "type": "navigate", "target": request.target_url, "step_id": normalized_steps[0]["id"]},
        )
    return {"steps": normalized_steps, "actions": normalized_actions}


def _parse_json_content(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("planner response must be a JSON object")
    return data


def _extract_documents(response: Any) -> list[str]:
    docs: list[str] = []
    candidates = response
    if isinstance(response, dict):
        for key in ("documents", "results", "data", "docs"):
            if key in response:
                candidates = response[key]
                break
    if isinstance(candidates, dict):
        candidates = list(candidates.values())
    if not isinstance(candidates, list):
        return docs

    for item in candidates:
        if isinstance(item, str):
            docs.append(item)
        elif isinstance(item, dict):
            title = item.get("title") or item.get("doc_title") or ""
            content = item.get("content") or item.get("text") or item.get("document") or ""
            value = "\n".join(part for part in [str(title).strip(), str(content).strip()] if part)
            if value:
                docs.append(value)
    return docs


def _write_trace(package_dir: Path | None, trace: dict[str, Any]) -> None:
    if package_dir is None:
        return
    package_dir.mkdir(parents=True, exist_ok=True)
    (package_dir / "planner_trace.json").write_text(json.dumps(trace, ensure_ascii=False, indent=2), encoding="utf-8")
