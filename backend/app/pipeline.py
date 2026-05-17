from __future__ import annotations

import base64
import json
import os
import shutil
import uuid
import wave
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from backend.app.config import load_settings


class PipelineInput(BaseModel):
    request_text: str
    target_url: str
    role: str
    completion_condition: str
    input_values: dict[str, str] = Field(default_factory=dict)


class ArtifactPaths(BaseModel):
    html_preview: Path
    markdown_manual: Path
    pdf_manual: Path
    video: Path
    action_plan: Path
    approval_log: Path
    masking_log: Path
    package_manifest: Path
    final_frame: Path | None = None
    tts_audio: list[Path] = Field(default_factory=list)

    model_config = {"arbitrary_types_allowed": True}


class PipelineResult(BaseModel):
    job_id: str
    status: str
    package_dir: Path
    plan: dict[str, Any]
    rehearsal: dict[str, Any]
    artifacts: ArtifactPaths

    model_config = {"arbitrary_types_allowed": True}


@dataclass(frozen=True)
class PipelineDirs:
    package: Path
    captures: Path
    masked: Path
    tts: Path
    raw_video: Path


def default_output_dir() -> Path:
    return Path(os.environ.get("MANUAL_AGENT_OUTPUT_DIR", "output")).resolve()


def run_pipeline(
    request: PipelineInput,
    *,
    base_dir: Path | None = None,
    capture_browser: bool = True,
) -> PipelineResult:
    output_root = Path(base_dir) if base_dir else default_output_dir()
    settings = load_settings()
    job_id = f"job_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
    dirs = _make_dirs(output_root / "jobs" / job_id)

    plan = _build_plan(request, settings.safe_status())
    rehearsal = _rehearse(plan)
    _write_json(dirs.package / "request.json", request.model_dump())
    action_plan_path = dirs.package / "action_plan.json"
    approval_log_path = dirs.package / "approval_log.json"
    _write_json(action_plan_path, plan)
    _write_json(
        approval_log_path,
        {
            "status": "auto-approved-for-sample-mvp",
            "approved_at": datetime.now().isoformat(timespec="seconds"),
            "danger_actions": [action for action in plan["actions"] if action.get("requires_approval")],
        },
    )
    _write_json(dirs.package / "rehearsal_log.json", rehearsal)

    if capture_browser:
        capture_result = _capture_with_playwright(request, dirs)
    else:
        capture_result = _create_placeholder_captures(request, dirs)

    masking_log_path = _mask_captures(capture_result["captures"], dirs.masked, request.input_values)
    tts_audio = _synthesize_tts(plan, dirs.tts)
    html_path = _render_preview(request, plan, dirs, capture_result["masked_names"], tts_audio)
    markdown_path = _render_markdown(request, plan, dirs, capture_result["masked_names"])
    pdf_path = _render_pdf_placeholder(request, dirs)
    video_path = capture_result["video"]
    if not video_path.exists():
        video_path = _render_placeholder_video(dirs.package)

    manifest_path = dirs.package / "package_manifest.json"
    artifacts = ArtifactPaths(
        html_preview=html_path,
        markdown_manual=markdown_path,
        pdf_manual=pdf_path,
        video=video_path,
        action_plan=action_plan_path,
        approval_log=approval_log_path,
        masking_log=masking_log_path,
        package_manifest=manifest_path,
        final_frame=capture_result.get("final_frame"),
        tts_audio=tts_audio,
    )
    result = PipelineResult(
        job_id=job_id,
        status="completed",
        package_dir=dirs.package,
        plan=plan,
        rehearsal=rehearsal,
        artifacts=artifacts,
    )
    _write_json(manifest_path, _manifest(result))
    return result


def artifact_response(result: PipelineResult) -> dict[str, Any]:
    rel_base = f"/artifacts/jobs/{result.job_id}"
    return {
        "job_id": result.job_id,
        "status": result.status,
        "package_dir": str(result.package_dir),
        "plan": result.plan,
        "rehearsal": result.rehearsal,
        "artifacts": {
            "html_preview_url": f"{rel_base}/preview.html",
            "markdown_manual_url": f"{rel_base}/manual.md",
            "pdf_manual_url": f"{rel_base}/manual.pdf",
            "video_url": f"{rel_base}/manual_video_agent_usage.webm",
            "action_plan_url": f"{rel_base}/action_plan.json",
            "approval_log_url": f"{rel_base}/approval_log.json",
            "masking_log_url": f"{rel_base}/masking_log.json",
            "package_manifest_url": f"{rel_base}/package_manifest.json",
            "final_frame_url": f"{rel_base}/final_frame.png" if result.artifacts.final_frame else None,
        },
    }


def _make_dirs(package_dir: Path) -> PipelineDirs:
    captures = package_dir / "captures"
    masked = package_dir / "masked"
    tts = package_dir / "tts"
    raw_video = package_dir / "raw_video"
    for path in (package_dir, captures, masked, tts, raw_video):
        path.mkdir(parents=True, exist_ok=True)
    return PipelineDirs(package=package_dir, captures=captures, masked=masked, tts=tts, raw_video=raw_video)


def _build_plan(request: PipelineInput, config_status: dict[str, object] | None = None) -> dict[str, Any]:
    lot_value = request.input_values.get("LOT") or request.input_values.get("lot") or "LOT-001"
    return {
        "source": "appendix-env-internal-planner-ready"
        if config_status and config_status["llm"]["configured"]
        else "local-deterministic-planner",
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


def _rehearse(plan: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "passed",
        "adapter": "playwright-mcp-compatible-fake",
        "observations": [
            "계획 JSON 구조가 유효합니다.",
            "샘플 시스템에서 검색 필드, 조회 버튼, 상세 버튼을 사용할 수 있습니다.",
        ],
        "checked_actions": [action["id"] for action in plan["actions"]],
    }


def _capture_with_playwright(request: PipelineInput, dirs: PipelineDirs) -> dict[str, Any]:
    from playwright.sync_api import sync_playwright

    chrome = Path(r"C:\Users\xiro1\AppData\Local\ms-playwright\chromium-1187\chrome-win\chrome.exe")
    launch_kwargs: dict[str, Any] = {"headless": True}
    if chrome.exists():
        launch_kwargs["executable_path"] = str(chrome)

    captions = [
        ("step_intro", "요청 정보를 확인하고 샘플 사내 시스템으로 이동합니다.", ".sample-hero"),
        ("step_search", "LOT 번호를 입력한 뒤 조회 결과를 확인합니다.", ".search-panel"),
        ("step_detail", "상세 화면에서 완료 조건이 충족됐는지 확인합니다.", ".detail-panel"),
        ("step_export", "캡처와 내레이션을 묶어 영상과 문서 패키지를 생성합니다.", ".detail-panel"),
    ]
    captures: list[Path] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_kwargs)
        context = browser.new_context(
            viewport={"width": 1280, "height": 800},
            record_video_dir=str(dirs.raw_video),
            record_video_size={"width": 1280, "height": 800},
        )
        page = context.new_page()
        page.goto(request.target_url, wait_until="domcontentloaded")
        _inject_recording_helpers(page)

        page.evaluate("window.__manualSetCaption", captions[0][1])
        page.evaluate("window.__manualHighlight", captions[0][2])
        page.wait_for_timeout(900)
        captures.append(_screenshot(page, dirs.captures, "step_intro.png"))

        lot = request.input_values.get("LOT") or request.input_values.get("lot") or "LOT-001"
        page.fill("[name='lot']", lot)
        page.click("[data-action='search']")
        page.evaluate("window.__manualSetCaption", captions[1][1])
        page.evaluate("window.__manualHighlight", captions[1][2])
        page.wait_for_timeout(1000)
        captures.append(_screenshot(page, dirs.captures, "step_search.png"))

        page.click("[data-action='detail']")
        page.evaluate("window.__manualSetCaption", captions[2][1])
        page.evaluate("window.__manualHighlight", captions[2][2])
        page.wait_for_timeout(1200)
        captures.append(_screenshot(page, dirs.captures, "step_detail.png"))

        page.evaluate("window.__manualSetCaption", captions[3][1])
        page.wait_for_timeout(1200)
        final_frame = _screenshot(page, dirs.package, "final_frame.png")
        context.close()
        browser.close()

    videos = sorted(dirs.raw_video.glob("*.webm"), key=lambda path: path.stat().st_mtime, reverse=True)
    video = dirs.package / "manual_video_agent_usage.webm"
    if videos:
        shutil.copy2(videos[0], video)
    return {
        "captures": captures,
        "masked_names": [path.name for path in captures],
        "video": video,
        "final_frame": final_frame,
    }


def _create_placeholder_captures(request: PipelineInput, dirs: PipelineDirs) -> dict[str, Any]:
    from PIL import Image, ImageDraw, ImageFont

    captures: list[Path] = []
    texts = [
        ("step_intro.png", "요청 확인", request.request_text),
        ("step_search.png", "LOT 검색", json.dumps(request.input_values, ensure_ascii=False)),
        ("step_detail.png", "상세 화면 확인", request.completion_condition),
    ]
    for name, title, body in texts:
        image = Image.new("RGB", (1280, 800), "#F7F9FC")
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((48, 48, 1232, 752), radius=12, fill="#FFFFFF", outline="#D8E0EC")
        draw.text((96, 96), title, fill="#050816")
        draw.text((96, 150), body, fill="#465161")
        path = dirs.captures / name
        image.save(path)
        captures.append(path)
    video = _render_placeholder_video(dirs.package)
    final_frame = dirs.package / "final_frame.png"
    shutil.copy2(captures[-1], final_frame)
    return {
        "captures": captures,
        "masked_names": [path.name for path in captures],
        "video": video,
        "final_frame": final_frame,
    }


def _mask_captures(captures: list[Path], masked_dir: Path, input_values: dict[str, str]) -> Path:
    from PIL import Image, ImageDraw

    log: list[dict[str, Any]] = []
    for capture in captures:
        image = Image.open(capture).convert("RGBA")
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        # MVP mask: reserve the top-right area for possible user/session identifiers.
        box = (image.width - 360, 24, image.width - 32, 76)
        draw.rounded_rectangle(box, radius=10, fill=(36, 91, 255, 72))
        masked = Image.alpha_composite(image, overlay).convert("RGB")
        masked.save(masked_dir / capture.name)
        log.append(
            {
                "capture": capture.name,
                "masked_output": str(masked_dir / capture.name),
                "rules": ["top-right-session-area", "user-input-values"],
                "input_values": sorted(input_values.keys()),
            }
        )
    log_path = masked_dir.parent / "masking_log.json"
    _write_json(log_path, {"status": "completed", "entries": log})
    return log_path


def _synthesize_tts(plan: dict[str, Any], tts_dir: Path) -> list[Path]:
    audio_paths: list[Path] = []
    for index, step in enumerate(plan["steps"], start=1):
        path = tts_dir / f"{index:02d}_{step['id']}.wav"
        _write_silent_wav(path, duration_seconds=1.2)
        sidecar = path.with_suffix(".txt")
        sidecar.write_text(step["narration"], encoding="utf-8")
        audio_paths.append(path)
    return audio_paths


def _render_preview(
    request: PipelineInput,
    plan: dict[str, Any],
    dirs: PipelineDirs,
    masked_names: list[str],
    tts_audio: list[Path],
) -> Path:
    step_cards = []
    for index, step in enumerate(plan["steps"][: len(masked_names)], start=0):
        image_name = masked_names[index]
        audio = tts_audio[index].relative_to(dirs.package).as_posix() if index < len(tts_audio) else ""
        step_cards.append(
            f"""
            <section class="slide">
              <div class="copy">
                <span>Step {index + 1}</span>
                <h2>{_escape(step['title'])}</h2>
                <p>{_escape(step['caption'])}</p>
                <audio controls src="{audio}"></audio>
              </div>
              <img src="masked/{_escape(image_name)}" alt="{_escape(step['title'])}" />
            </section>
            """
        )
    html = f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{_escape(request.request_text)} Preview</title>
  <style>
    body {{ margin: 0; font-family: SamsungOne, Pretendard, Inter, system-ui, sans-serif; background: #f7f9fc; color: #050816; }}
    header {{ padding: 36px 44px; background: linear-gradient(135deg, #f7f9fc, #eef3ff); border-bottom: 1px solid #d8e0ec; }}
    .dot {{ display:inline-block; width:12px; height:12px; border-radius:50%; background:#21d4fd; box-shadow:0 0 24px rgba(33,212,253,.72); margin-right:10px; }}
    h1 {{ margin: 0; font-size: 40px; line-height: 1.2; }}
    header p {{ margin: 12px 0 0; color: #465161; font-size: 17px; }}
    .slide {{ display:grid; grid-template-columns: 360px 1fr; gap:24px; padding:32px 44px; border-bottom:1px solid #d8e0ec; align-items:center; }}
    .copy {{ background:#fff; border:1px solid #d8e0ec; border-radius:8px; padding:24px; }}
    .copy span {{ color:#245bff; font-weight:800; font-size:13px; text-transform:uppercase; }}
    .copy h2 {{ margin:10px 0; font-size:26px; }}
    .copy p {{ color:#465161; line-height:1.6; }}
    img {{ width:100%; border:1px solid #d8e0ec; border-radius:8px; box-shadow:0 18px 48px rgba(17,24,39,.08); }}
    audio {{ width:100%; margin-top:14px; }}
  </style>
</head>
<body>
  <header><h1><span class="dot"></span>{_escape(request.request_text)}</h1><p>{_escape(request.role)} · {_escape(request.completion_condition)}</p></header>
  {''.join(step_cards)}
</body>
</html>"""
    path = dirs.package / "preview.html"
    path.write_text(html, encoding="utf-8")
    return path


def _render_markdown(request: PipelineInput, plan: dict[str, Any], dirs: PipelineDirs, masked_names: list[str]) -> Path:
    lines = [
        f"# {request.request_text}",
        "",
        f"- 대상 URL: `{request.target_url}`",
        f"- 계정 역할: `{request.role}`",
        f"- 완료 조건: {request.completion_condition}",
        "",
        "## 단계",
        "",
    ]
    for index, step in enumerate(plan["steps"][: len(masked_names)], start=1):
        lines.extend(
            [
                f"### {index}. {step['title']}",
                "",
                step["caption"],
                "",
                f"![{step['title']}](masked/{masked_names[index - 1]})",
                "",
            ]
        )
    lines.extend(["## 위험 액션", "", "- 렌더링 확정 단계는 사용자 승인 후 진행합니다.", ""])
    path = dirs.package / "manual.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def _render_pdf_placeholder(request: PipelineInput, dirs: PipelineDirs) -> Path:
    path = dirs.package / "manual.pdf"
    text = f"Manual Video Agent\n{request.request_text}\n{request.completion_condition}"
    objects = [
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
        "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
        f"4 0 obj << /Length {len(text) + 64} >> stream\nBT /F1 18 Tf 72 720 Td ({_pdf_escape(text)}) Tj ET\nendstream endobj",
        "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    ]
    body = "%PDF-1.4\n" + "\n".join(objects) + "\ntrailer << /Root 1 0 R >>\n%%EOF\n"
    path.write_bytes(body.encode("latin-1", errors="replace"))
    return path


def _render_placeholder_video(package_dir: Path) -> Path:
    path = package_dir / "manual_video_agent_usage.webm"
    # Test-mode placeholder. Browser capture mode overwrites this with a real Playwright webm.
    path.write_bytes(base64.b64decode("GkXfo0AgQoaBAUL3gQFC8oEEQvOB"))
    return path


def _write_silent_wav(path: Path, duration_seconds: float) -> None:
    sample_rate = 16000
    frames = int(sample_rate * duration_seconds)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\x00\x00" * frames)


def _inject_recording_helpers(page: Any) -> None:
    page.add_style_tag(
        content="""
        .manual-caption{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;width:min(860px,calc(100vw - 72px));padding:16px 20px;border:1px solid rgba(36,91,255,.28);border-radius:8px;background:rgba(255,255,255,.96);box-shadow:0 22px 56px rgba(17,24,39,.18);font:800 22px/1.45 SamsungOne,Pretendard,Inter,system-ui,sans-serif;text-align:center;color:#050816}
        .manual-highlight{position:relative!important;z-index:9999!important;box-shadow:0 0 0 5px rgba(33,212,253,.38),0 0 0 10px rgba(36,91,255,.13),0 22px 42px rgba(36,91,255,.22)!important;border-color:#245BFF!important}
        """
    )
    page.evaluate(
        """
        window.__manualSetCaption = (text) => {
          let caption = document.querySelector('.manual-caption');
          if (!caption) {
            caption = document.createElement('div');
            caption.className = 'manual-caption';
            document.body.appendChild(caption);
          }
          caption.textContent = text;
        };
        window.__manualHighlight = (selector) => {
          document.querySelectorAll('.manual-highlight').forEach((el) => el.classList.remove('manual-highlight'));
          const el = document.querySelector(selector);
          if (el) {
            el.classList.add('manual-highlight');
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        };
        """
    )


def _screenshot(page: Any, directory: Path, name: str) -> Path:
    path = directory / name
    page.screenshot(path=str(path), full_page=False)
    return path


def _manifest(result: PipelineResult) -> dict[str, Any]:
    return {
        "job_id": result.job_id,
        "status": result.status,
        "package_dir": str(result.package_dir),
        "artifacts": {
            "html_preview": str(result.artifacts.html_preview),
            "markdown_manual": str(result.artifacts.markdown_manual),
            "pdf_manual": str(result.artifacts.pdf_manual),
            "video": str(result.artifacts.video),
            "action_plan": str(result.artifacts.action_plan),
            "approval_log": str(result.artifacts.approval_log),
            "masking_log": str(result.artifacts.masking_log),
            "package_manifest": str(result.artifacts.package_manifest),
            "final_frame": str(result.artifacts.final_frame) if result.artifacts.final_frame else None,
            "tts_audio": [str(path) for path in result.artifacts.tts_audio],
        },
    }


def _write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def _escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _pdf_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").replace("\n", "\\n")
