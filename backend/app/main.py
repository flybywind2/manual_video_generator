from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.app.config import load_settings
from backend.app.pipeline import (
    PipelineInput,
    artifact_response,
    continue_pipeline_draft,
    create_pipeline_draft,
    draft_response,
    rerender_pipeline_package,
    run_pipeline,
)

APP_DIR = Path(__file__).resolve().parent
TEXT_ARTIFACT_SUFFIXES = {".md", ".json", ".jsonl", ".vtt", ".txt", ".html"}
MAX_TEXT_ARTIFACT_BYTES = 2 * 1024 * 1024


class TextArtifactUpdate(BaseModel):
    content: str

app = FastAPI(title="Manual Video Agent")
app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config/status")
def config_status() -> dict[str, object]:
    return load_settings().safe_status()


@app.get("/", response_class=HTMLResponse)
def home() -> str:
    return (APP_DIR / "templates" / "index.html").read_text(encoding="utf-8")


@app.get("/sample", response_class=HTMLResponse)
def sample() -> str:
    return (APP_DIR / "templates" / "sample.html").read_text(encoding="utf-8")


@app.get("/api/artifacts/text/{artifact_path:path}")
def read_text_artifact(artifact_path: str) -> dict[str, object]:
    target = _resolve_artifact_path(artifact_path)
    _ensure_editable_text_artifact(target)
    return {
        "path": artifact_path,
        "name": target.name,
        "editable": True,
        "content": target.read_text(encoding="utf-8"),
    }


@app.put("/api/artifacts/text/{artifact_path:path}")
def update_text_artifact(artifact_path: str, payload: TextArtifactUpdate) -> dict[str, object]:
    target = _resolve_artifact_path(artifact_path)
    _ensure_editable_text_artifact(target)
    encoded = payload.content.encode("utf-8")
    if len(encoded) > MAX_TEXT_ARTIFACT_BYTES:
        raise HTTPException(status_code=413, detail="text artifact is too large")
    _validate_text_artifact_content(target, payload.content)
    target.write_text(payload.content, encoding="utf-8")
    return {
        "path": artifact_path,
        "name": target.name,
        "saved": True,
        "bytes": len(encoded),
    }


@app.get("/artifacts/{artifact_path:path}")
def artifact_file(artifact_path: str) -> FileResponse:
    target = _resolve_artifact_path(artifact_path)
    return FileResponse(target)


def _resolve_artifact_path(artifact_path: str) -> Path:
    output_dir = Path(load_settings().output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    target = (output_dir / artifact_path).resolve()
    try:
        target.relative_to(output_dir)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="artifact not found") from exc
    if not target.is_file():
        raise HTTPException(status_code=404, detail="artifact not found")
    return target


def _ensure_editable_text_artifact(target: Path) -> None:
    if target.suffix.lower() not in TEXT_ARTIFACT_SUFFIXES:
        raise HTTPException(status_code=415, detail="artifact is not an editable text file")
    if target.stat().st_size > MAX_TEXT_ARTIFACT_BYTES:
        raise HTTPException(status_code=413, detail="text artifact is too large")
    try:
        target.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=415, detail="artifact is not UTF-8 text") from exc


def _validate_text_artifact_content(target: Path, content: str) -> None:
    suffix = target.suffix.lower()
    if suffix == ".json":
        import json

        try:
            json.loads(content)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=422, detail=f"invalid JSON: {exc.msg}") from exc
    if suffix == ".jsonl":
        import json

        for line_number, line in enumerate(content.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                json.loads(line)
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=422, detail=f"invalid JSONL at line {line_number}: {exc.msg}") from exc


@app.post("/api/pipeline/run")
def run_pipeline_api(payload: PipelineInput, capture_browser: bool = True) -> dict:
    result = run_pipeline(payload, capture_browser=capture_browser)
    return artifact_response(result)


@app.post("/api/pipeline/draft")
def create_pipeline_draft_api(payload: PipelineInput, capture_browser: bool = True) -> dict:
    result = create_pipeline_draft(payload, capture_browser=capture_browser)
    return draft_response(result)


@app.post("/api/pipeline/continue/{job_id}")
def continue_pipeline_api(job_id: str, capture_browser: bool | None = None) -> dict:
    try:
        result = continue_pipeline_draft(job_id, capture_browser=capture_browser)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="workflow draft not found") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return artifact_response(result)


@app.post("/api/pipeline/rerender/{job_id}")
def rerender_pipeline_api(job_id: str) -> dict:
    try:
        result = rerender_pipeline_package(job_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="workflow package not found") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return artifact_response(result)
