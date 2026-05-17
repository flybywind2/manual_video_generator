from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from backend.app.config import AppSettings


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
        plan = _call_llm_planner(request, settings, context_docs, post)
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
    lot_value = request.input_values.get("LOT") or request.input_values.get("lot") or "LOT-001"
    return {
        "source": "local-deterministic-planner",
        "config_status": config_status or {},
        "steps": [
            {
                "id": "step_intro",
                "title": "요청 확인",
                "caption": "입력된 요청과 대상 시스템 정보를 확인합니다.",
                "narration": "입력된 요청과 대상 시스템 정보를 확인합니다.",
            },
            {
                "id": "step_search",
                "title": "LOT 검색",
                "caption": f"LOT 값 {lot_value}를 입력하고 조회합니다.",
                "narration": f"LOT 값 {lot_value}를 입력하고 조회합니다.",
            },
            {
                "id": "step_detail",
                "title": "상세 화면 확인",
                "caption": "상세 화면에서 완료 조건을 확인합니다.",
                "narration": "상세 화면에서 완료 조건을 확인합니다.",
            },
            {
                "id": "step_export",
                "title": "산출물 생성",
                "caption": "캡처, 마스킹, 내레이션, 문서와 영상을 패키징합니다.",
                "narration": "캡처, 마스킹, 내레이션, 문서와 영상을 패키징합니다.",
            },
        ],
        "actions": [
            {"id": "a1", "type": "navigate", "target": request.target_url, "step_id": "step_intro"},
            {"id": "a2", "type": "fill", "selector": "[name='lot']", "value": lot_value, "step_id": "step_search"},
            {"id": "a3", "type": "click", "selector": "[data-action='search']", "step_id": "step_search"},
            {"id": "a4", "type": "capture_step", "step_id": "step_search"},
            {"id": "a5", "type": "click", "selector": "[data-action='detail']", "step_id": "step_detail"},
            {"id": "a6", "type": "capture_step", "step_id": "step_detail"},
            {
                "id": "a7",
                "type": "danger_approval",
                "label": "렌더링 확정",
                "requires_approval": True,
                "step_id": "step_export",
                "danger": {"is_danger": True, "reasons": ["keyword:확정"]},
            },
        ],
    }


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
                    "{steps:[{id,title,caption,narration}], actions:[{id,type,step_id,selector?,target?,value?,requires_approval?}]}"
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
    response = post(url, headers, payload, settings.request_timeout_seconds)
    content = response["choices"][0]["message"]["content"]
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
