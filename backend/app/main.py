from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from backend.app.config import load_settings
from backend.app.pipeline import (
    PipelineInput,
    artifact_response,
    continue_pipeline_draft,
    create_pipeline_draft,
    draft_response,
    run_pipeline,
)

APP_DIR = Path(__file__).resolve().parent

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


@app.get("/artifacts/{artifact_path:path}")
def artifact_file(artifact_path: str) -> FileResponse:
    output_dir = Path(load_settings().output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    target = (output_dir / artifact_path).resolve()
    try:
        target.relative_to(output_dir)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="artifact not found") from exc
    if not target.is_file():
        raise HTTPException(status_code=404, detail="artifact not found")
    return FileResponse(target)


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
