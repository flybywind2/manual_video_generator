from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


REQUIRED_ARTIFACTS = {
    "html_preview",
    "markdown_manual",
    "video",
    "action_plan",
    "approval_log",
    "masking_log",
    "audit_log",
}

NON_EMPTY_ARTIFACTS = {
    "html_preview",
    "markdown_manual",
    "video",
    "action_plan",
    "approval_log",
    "masking_log",
    "audit_log",
}

REQUIRED_SUPPORTING_ARTIFACTS = {
    "request",
    "planner_trace",
    "rehearsal_log",
    "playwright_mcp_calls",
    "audit_log",
    "tts_metadata",
    "video_render",
    "opencode_prompt",
    "opencode_metadata",
    "hyperframes_composition",
    "hyperframes_manifest",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify a generated manual video package manifest.")
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()

    errors = verify_manifest(args.manifest)
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"Package verified: {args.manifest}")
    return 0


def verify_manifest(manifest_path: Path) -> list[str]:
    errors: list[str] = []
    if not manifest_path.is_file():
        return [f"manifest missing: {manifest_path}"]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [f"manifest is not valid JSON: {exc}"]

    if manifest.get("status") != "completed":
        errors.append(f"unexpected status: {manifest.get('status')!r}")

    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict):
        return ["artifacts object missing"]

    for key in sorted(REQUIRED_ARTIFACTS):
        path_value = artifacts.get(key)
        if not path_value:
            errors.append(f"artifact missing from manifest: {key}")
            continue
        path = Path(str(path_value))
        if not path.is_file():
            errors.append(f"artifact path does not exist: {key}={path}")
        elif key in NON_EMPTY_ARTIFACTS and path.stat().st_size == 0:
            errors.append(f"artifact path is empty: {key}={path}")

    supporting_artifacts = manifest.get("supporting_artifacts")
    if not isinstance(supporting_artifacts, dict):
        errors.append("supporting_artifacts object missing")
    else:
        for key in sorted(REQUIRED_SUPPORTING_ARTIFACTS):
            path_value = supporting_artifacts.get(key)
            if not path_value:
                errors.append(f"supporting artifact missing from manifest: {key}")
                continue
            path = Path(str(path_value))
            if not path.is_file():
                errors.append(f"supporting artifact path does not exist: {key}={path}")

    manual = _path_from(artifacts, "markdown_manual")
    if manual and manual.exists() and not manual.read_text(encoding="utf-8").strip():
        errors.append("manual.md is empty")

    audit = _path_from(artifacts, "audit_log")
    if audit and audit.exists():
        audit_errors = _verify_audit(audit, manifest.get("job_id", ""))
        errors.extend(audit_errors)

    tts_audio = artifacts.get("tts_audio", [])
    if not isinstance(tts_audio, list):
        errors.append("tts_audio must be a list")
    else:
        for path_value in tts_audio:
            path = Path(str(path_value))
            if not path.is_file():
                errors.append(f"tts audio path does not exist: {path}")
            elif path.stat().st_size == 0:
                errors.append(f"tts audio path is empty: {path}")

    tts_metadata = _path_from(artifacts, "tts_metadata")
    if tts_metadata and tts_metadata.exists():
        errors.extend(_verify_tts_metadata(tts_metadata))

    degradations = manifest.get("degradations", [])
    if not isinstance(degradations, list):
        errors.append("degradations must be a list")
    else:
        for index, item in enumerate(degradations):
            if not isinstance(item, dict) or not item.get("actor") or not item.get("reason"):
                errors.append(f"invalid degradation entry at index {index}")

    return errors


def _path_from(artifacts: dict[str, Any], key: str) -> Path | None:
    value = artifacts.get(key)
    return Path(str(value)) if value else None


def _verify_audit(path: Path, job_id: str) -> list[str]:
    errors: list[str] = []
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines:
        return ["audit_log.jsonl is empty"]
    for line_number, line in enumerate(lines, start=1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(f"audit line {line_number} is invalid JSON: {exc}")
            continue
        for key in ("timestamp", "run_id", "actor", "status"):
            if not event.get(key):
                errors.append(f"audit line {line_number} missing {key}")
        if job_id and event.get("run_id") != job_id:
            errors.append(f"audit line {line_number} run_id mismatch")
    return errors


def _verify_tts_metadata(path: Path) -> list[str]:
    errors: list[str] = []
    try:
        metadata = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [f"tts metadata is not valid JSON: {exc}"]
    entries = metadata.get("entries", [])
    if not isinstance(entries, list):
        return ["tts metadata entries must be a list"]
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            errors.append(f"tts metadata entry {index} must be an object")
            continue
        audio = entry.get("audio")
        if not audio:
            errors.append(f"tts metadata entry {index} missing audio")
            continue
        audio_path = Path(str(audio))
        if not audio_path.is_file():
            errors.append(f"tts metadata audio path does not exist: {audio_path}")
        elif audio_path.stat().st_size == 0:
            errors.append(f"tts metadata audio path is empty: {audio_path}")
    return errors


if __name__ == "__main__":
    raise SystemExit(main())
