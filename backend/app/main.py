from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from backend.app.pipeline import PipelineInput, artifact_response, default_output_dir, run_pipeline

APP_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = default_output_dir()
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Manual Video Agent")
app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
app.mount("/artifacts", StaticFiles(directory=OUTPUT_DIR), name="artifacts")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
def home() -> str:
    return (APP_DIR / "templates" / "index.html").read_text(encoding="utf-8")


@app.get("/sample", response_class=HTMLResponse)
def sample() -> str:
    return (APP_DIR / "templates" / "sample.html").read_text(encoding="utf-8")


@app.post("/api/pipeline/run")
def run_pipeline_api(payload: PipelineInput, capture_browser: bool = True) -> dict:
    result = run_pipeline(payload, capture_browser=capture_browser)
    return artifact_response(result)
