import pytest

from backend.app.policies import ApprovalGate, ApprovalRequiredError, RiskPolicy


def test_risk_policy_marks_write_like_actions_as_dangerous():
    action = {"id": "a1", "type": "click", "label": "저장", "step_id": "step_save"}

    result = RiskPolicy().classify(action)

    assert result["is_danger"] is True
    assert "keyword:저장" in result["reasons"]


def test_approval_gate_blocks_risky_actions_without_approval():
    plan = {
        "actions": [
            {"id": "a1", "type": "click", "label": "저장", "step_id": "step_save"},
        ]
    }

    with pytest.raises(ApprovalRequiredError):
        ApprovalGate(mode="strict").approve(plan)


def test_approval_gate_allows_sample_mvp_auto_approval_and_records_gate():
    plan = {
        "actions": [
            {"id": "a1", "type": "click", "label": "저장", "step_id": "step_save"},
        ]
    }

    approval = ApprovalGate(mode="sample-mvp").approve(plan)

    assert approval["status"] == "auto-approved-for-sample-mvp"
    assert approval["gate"] == "ApprovalGate"
    assert approval["danger_actions"][0]["id"] == "a1"
