from __future__ import annotations

import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from backend.app.redaction import redact_sensitive


class BrowserUseDiscoveryInput(BaseModel):
    request_text: str
    target_url: str
    role: str = ""
    completion_condition: str = ""
    input_values: dict[str, str] = Field(default_factory=dict)
    viewport_mode: str = "desktop"
    max_steps: int = 8
    auth_profile: str = ""


class BrowserUseDiscoveryResult(BaseModel):
    job_id: str
    status: str
    package_dir: Path
    manifest_path: Path
    scenario_draft_path: Path
    candidate_action_plan_path: Path
    manifest: dict[str, Any]

    model_config = {"arbitrary_types_allowed": True}


def create_browser_use_discovery(
    request: BrowserUseDiscoveryInput,
    *,
    output_dir: Path,
) -> BrowserUseDiscoveryResult:
    """Create a bounded browser-use discovery package.

    This is intentionally a discovery contract, not the final runner. The
    current implementation is deterministic and dependency-free so the API and
    artifact shape are stable on no-Docker/internal PCs. A real browser-use
    executor can later replace the candidate collection internals while keeping
    this manifest contract.
    """

    job_id = f"discovery_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
    package_dir = output_dir / "jobs" / job_id
    package_dir.mkdir(parents=True, exist_ok=True)

    manifest = _build_manifest(request, job_id=job_id)
    scenario_draft = _build_scenario_draft(request, manifest)
    candidate_action_plan = _build_candidate_action_plan(request, manifest)

    manifest_path = package_dir / "browser_use_discovery_manifest.json"
    scenario_draft_path = package_dir / "scenario_draft.md"
    candidate_action_plan_path = package_dir / "candidate_action_plan.json"

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    scenario_draft_path.write_text(scenario_draft, encoding="utf-8")
    candidate_action_plan_path.write_text(
        json.dumps(candidate_action_plan, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    return BrowserUseDiscoveryResult(
        job_id=job_id,
        status="draft_only",
        package_dir=package_dir,
        manifest_path=manifest_path,
        scenario_draft_path=scenario_draft_path,
        candidate_action_plan_path=candidate_action_plan_path,
        manifest=manifest,
    )


def discovery_response(result: BrowserUseDiscoveryResult, *, output_dir: Path) -> dict[str, Any]:
    base = result.package_dir.relative_to(output_dir).as_posix()
    return {
        "job_id": result.job_id,
        "status": result.status,
        "approval_required": True,
        "package_dir": str(result.package_dir),
        "manifest": result.manifest,
        "artifacts": {
            "manifest": f"/artifacts/{base}/browser_use_discovery_manifest.json",
            "scenario_draft": f"/artifacts/{base}/scenario_draft.md",
            "candidate_action_plan": f"/artifacts/{base}/candidate_action_plan.json",
        },
    }


def _build_manifest(request: BrowserUseDiscoveryInput, *, job_id: str) -> dict[str, Any]:
    viewport = _viewport(request.viewport_mode)
    effective_values = _effective_input_values(request)
    candidate_inputs = [
        {
            "label": key,
            "selector": "",
            "suggested_value_key": key,
            "required": True,
            "source": "explicit_or_inferred",
        }
        for key in sorted(effective_values)
    ]
    candidate_actions = [
        {
            "intent": "navigate_to_target",
            "action_type": "navigate",
            "selector": "",
            "visible_text": "",
            "target": request.target_url,
            "confidence": 1.0,
            "risk": "read_only",
            "evidence": "target_url",
        },
        {
            "intent": "capture_initial_screen",
            "action_type": "capture_step",
            "selector": "",
            "visible_text": "",
            "confidence": 1.0,
            "risk": "read_only",
            "evidence": "baseline capture",
        },
    ]
    candidate_actions.extend(_candidate_click_actions(request))
    for item in candidate_inputs:
        candidate_actions.append(
            {
                "intent": f"fill_{item['suggested_value_key']}",
                "action_type": "fill_by_label",
                "selector": "",
                "visible_text": item["label"],
                "value_key": item["suggested_value_key"],
                "confidence": 0.55,
                "risk": "read_only",
                "evidence": "request input values",
            }
        )

    return {
        "version": "1.0",
        "adapter": "browser-use-discovery",
        "status": "draft_only",
        "approval_required": True,
        "run_id": job_id,
        "target_url": request.target_url,
        "viewport": viewport,
        "auth_profile": request.auth_profile,
        "max_steps": max(1, min(int(request.max_steps or 8), 30)),
        "request": redact_sensitive(
            {
                "request_text": request.request_text,
                "role": request.role,
                "completion_condition": request.completion_condition,
                "input_values": request.input_values,
            }
        ),
        "visited_urls": [request.target_url] if request.target_url else [],
        "candidate_actions": candidate_actions,
        "candidate_inputs": candidate_inputs,
        "candidate_masks": _candidate_masks(request),
        "screenshots": [],
        "dom_summaries": [],
        "warnings": _warnings(request, viewport),
    }


def _build_candidate_action_plan(request: BrowserUseDiscoveryInput, manifest: dict[str, Any]) -> dict[str, Any]:
    actions = []
    for index, candidate in enumerate(manifest["candidate_actions"], start=1):
        action_type = candidate["action_type"]
        action: dict[str, Any] = {
            "id": f"du{index}",
            "type": action_type,
            "source": "browser-use-discovery",
            "requires_review": True,
        }
        if action_type == "navigate":
            action["target"] = candidate.get("target", request.target_url)
        if action_type == "click_by_text":
            action["label"] = candidate.get("visible_text", "")
            action["texts"] = candidate.get("texts", [candidate.get("visible_text", "")])
        if action_type == "fill_by_label":
            action["label"] = candidate.get("visible_text", "")
            action["value_key"] = candidate.get("value_key", "")
            action["value"] = request.input_values.get(str(candidate.get("value_key", "")), "")
        actions.append(action)

    return {
        "source": "browser-use-discovery-draft",
        "approval_required": True,
        "steps": [
            {
                "id": "discovery_review",
                "title": "browser-use 탐색 결과 검토",
                "caption": "후보 동작은 관리자 검토 후 기존 Playwright 실행 계획으로 승격합니다.",
                "narration": "탐색 결과를 검토한 뒤 실제 촬영 계획으로 확정합니다.",
            }
        ],
        "actions": actions,
    }


def _build_scenario_draft(request: BrowserUseDiscoveryInput, manifest: dict[str, Any]) -> str:
    lines = [
        "# Browser-Use Scenario Draft",
        "",
        "이 초안은 최종 실행 계획이 아닙니다. 관리자 검토 후 Playwright action plan으로 승격해야 합니다.",
        "",
        f"- 대상 URL: {request.target_url}",
        f"- viewport: {manifest['viewport']['mode']}",
        f"- 역할: {request.role or '미지정'}",
        f"- 완료 조건: {request.completion_condition or '미지정'}",
        "",
        "## 후보 입력값",
    ]
    if manifest["candidate_inputs"]:
        for item in manifest["candidate_inputs"]:
            lines.append(f"- {item['label']} -> `{item['suggested_value_key']}`")
    else:
        lines.append("- 없음")
    lines.extend(["", "## 후보 동작"])
    for action in manifest["candidate_actions"]:
        label = action.get("visible_text") or action.get("intent")
        lines.append(f"- {action['action_type']}: {label} (risk={action['risk']}, confidence={action['confidence']})")
    lines.extend(["", "## 경고"])
    for warning in manifest["warnings"]:
        lines.append(f"- {warning}")
    return "\n".join(lines) + "\n"


def _viewport(mode: str) -> dict[str, Any]:
    normalized = (mode or "desktop").strip().lower()
    if normalized == "mobile":
        return {
            "mode": "mobile",
            "width": 390,
            "height": 844,
            "device_scale_factor": 2,
            "is_mobile": True,
        }
    return {
        "mode": "desktop",
        "width": 1365,
        "height": 768,
        "device_scale_factor": 1,
        "is_mobile": False,
    }


def _effective_input_values(request: BrowserUseDiscoveryInput) -> dict[str, str]:
    values = {str(key).strip(): str(value).strip() for key, value in request.input_values.items() if str(key).strip()}
    text = f"{request.request_text} {request.completion_condition}"
    for key, pattern in {
        "LOT": r"(?<![A-Za-z0-9])(LOT[-_]?[A-Za-z0-9]+)",
        "검색어": r"(?:검색어|질문|프롬프트)\s*[:=]?\s*([^\n,，。]{2,80})",
        "라인": r"(?:라인|line)\s*[:=]?\s*([A-Za-z][A-Za-z0-9_-]{0,12})",
    }.items():
        if key not in values:
            match = re.search(pattern, text, flags=re.IGNORECASE)
            if match:
                values[key] = match.group(1).strip()
    return values


def _candidate_click_actions(request: BrowserUseDiscoveryInput) -> list[dict[str, Any]]:
    text = f"{request.request_text} {request.completion_condition}".lower()
    groups: list[tuple[str, list[str]]] = []
    if any(keyword in text for keyword in ("모달", "popup", "dialog")):
        groups.append(("close_modal", ["닫기", "창닫기", "확인", "Close"]))
    if any(keyword in text for keyword in ("조회", "검색", "search")):
        groups.append(("run_search", ["조회", "검색", "Search"]))
    if any(keyword in text for keyword in ("상세", "detail")):
        groups.append(("open_detail", ["상세 보기", "상세", "Detail", "Details"]))
    if any(keyword in text for keyword in ("챗봇", "chatbot", "채팅", "질문", "prompt")):
        groups.append(("send_prompt", ["전송", "보내기", "Send"]))

    return [
        {
            "intent": intent,
            "action_type": "click_by_text",
            "selector": "",
            "visible_text": texts[0],
            "texts": texts,
            "confidence": 0.62,
            "risk": "read_only",
            "evidence": "request intent keywords",
        }
        for intent, texts in groups
    ]


def _candidate_masks(request: BrowserUseDiscoveryInput) -> list[dict[str, str]]:
    masks = [
        {"selector": "input[type='password']", "reason": "password field"},
        {"selector": "[data-private='true']", "reason": "explicit private marker"},
        {"selector": ".user-name,.employee-id,.email", "reason": "possible personal information"},
    ]
    if request.viewport_mode.strip().lower() == "mobile":
        masks.append({"selector": ".mobile-profile,.bottom-sheet .user", "reason": "mobile profile area"})
    return masks


def _warnings(request: BrowserUseDiscoveryInput, viewport: dict[str, Any]) -> list[str]:
    warnings = [
        "browser-use discovery output is draft-only and must not run without admin review",
        "final recording must be replayed by the Playwright runner",
    ]
    if viewport["mode"] == "mobile":
        warnings.append("mobile discovery covers responsive web viewport, not native mobile app automation")
    if request.auth_profile:
        warnings.append("auth profile is a reference only; secrets are not stored in the manifest")
    return warnings

