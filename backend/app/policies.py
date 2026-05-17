from __future__ import annotations

from datetime import datetime
from typing import Any


class ApprovalRequiredError(RuntimeError):
    pass


class RiskPolicy:
    danger_keywords = ("저장", "등록", "제출", "삭제", "결재", "발송", "승인", "확정", "업로드")

    def classify(self, action: dict[str, Any]) -> dict[str, Any]:
        if action.get("requires_approval") or action.get("danger", {}).get("is_danger"):
            reasons = list(action.get("danger", {}).get("reasons") or ["requires_approval"])
            return {"is_danger": True, "reasons": reasons}

        haystack = " ".join(
            str(action.get(key, ""))
            for key in ("label", "description", "selector", "target", "value", "type")
        )
        reasons = [f"keyword:{keyword}" for keyword in self.danger_keywords if keyword in haystack]
        return {"is_danger": bool(reasons), "reasons": reasons}


class ApprovalGate:
    def __init__(self, *, mode: str = "strict", risk_policy: RiskPolicy | None = None) -> None:
        self.mode = mode
        self.risk_policy = risk_policy or RiskPolicy()

    def approve(self, plan: dict[str, Any]) -> dict[str, Any]:
        danger_actions = []
        for action in plan.get("actions", []):
            risk = self.risk_policy.classify(action)
            if risk["is_danger"]:
                action["requires_approval"] = True
                action["danger"] = risk
                danger_actions.append(action)

        if danger_actions and self.mode != "sample-mvp":
            ids = ", ".join(str(action.get("id")) for action in danger_actions)
            raise ApprovalRequiredError(f"approval required for dangerous actions: {ids}")

        return {
            "status": "auto-approved-for-sample-mvp" if self.mode == "sample-mvp" else "approved",
            "gate": "ApprovalGate",
            "policy": "RiskPolicy",
            "mode": self.mode,
            "approved_at": datetime.now().isoformat(timespec="seconds"),
            "danger_actions": danger_actions,
        }
