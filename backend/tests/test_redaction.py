from backend.app.redaction import RedactionPipeline, redact_sensitive


def test_redact_sensitive_masks_secret_like_keys_recursively():
    payload = {
        "input_values": {
            "LOT": "LOT-001",
            "password": "plain-password",
            "nested": {"otp_code": "123456", "api_key": "sk-secret"},
        },
        "actions": [
            {"selector": "[name='password']", "value": "plain-password"},
            {"selector": "[name='lot']", "value": "LOT-001"},
        ],
    }

    redacted = redact_sensitive(payload)

    assert redacted["input_values"]["LOT"] == "LOT-001"
    assert redacted["input_values"]["password"] == "<redacted>"
    assert redacted["input_values"]["nested"]["otp_code"] == "<redacted>"
    assert redacted["input_values"]["nested"]["api_key"] == "<redacted>"
    assert redacted["actions"][0]["value"] == "<redacted>"
    assert redacted["actions"][1]["value"] == "LOT-001"


def test_redaction_pipeline_redacts_secret_assignments_and_sensitive_input_values():
    pipeline = RedactionPipeline(sensitive_values={"password": "plain-password", "LOT": "LOT-001"})

    text = pipeline.redact_text("password=plain-password LOT-001 token:abc123")

    assert "plain-password" not in text
    assert "abc123" not in text
    assert "LOT-001" in text
