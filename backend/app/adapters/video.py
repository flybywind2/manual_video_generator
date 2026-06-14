from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from backend.app.adapters.skills import ensure_hyperframes_skills
from backend.app.config import AppSettings


CommandRunner = Callable[..., subprocess.CompletedProcess]


@dataclass(frozen=True)
class VideoRenderResult:
    video_path: Path
    composition_dir: Path
    metadata_path: Path
    skills_metadata_path: Path
    used_fallback: bool


def render_final_video(
    *,
    plan: dict[str, Any],
    package_dir: Path,
    preview_html: Path,
    fallback_video: Path,
    settings: AppSettings,
    tts_audio: list[Path] | None = None,
    command_runner: CommandRunner | None = None,
) -> VideoRenderResult:
    audio_paths = [Path(path) for path in (tts_audio or [])]
    duration_seconds, duration_source, step_durations = _composition_timing(plan, audio_paths)
    composition_dir = _write_hyperframes_composition(
        plan,
        package_dir,
        preview_html,
        fallback_video,
        duration_seconds=duration_seconds,
        duration_source=duration_source,
        step_durations=step_durations,
    )
    metadata_path = package_dir / "video_render.json"
    runner = subprocess.run if command_runner is None else command_runner
    renderer = settings.video_renderer.lower()

    metadata: dict[str, Any] = {
        "renderer": renderer,
        "composition_dir": str(composition_dir),
        "preview_html": str(preview_html),
        "fallback_video": str(fallback_video),
        "composition_duration_seconds": duration_seconds,
        "composition_duration_source": duration_source,
        "used_fallback": True,
    }
    has_tts_timeline = duration_source == "tts_audio" and _positive_float(plan.get("target_duration_seconds")) > 0
    mux_target_duration_seconds = (
        duration_seconds
        if duration_source == "target_video_duration" or has_tts_timeline
        else 0.0
    )
    skills = ensure_hyperframes_skills(settings, package_dir)
    metadata["skills_metadata"] = str(skills.metadata_path)
    metadata["skills_status"] = skills.status
    if renderer != "hyperframes":
        metadata["status"] = "skipped"
        metadata["reason"] = "video renderer is not hyperframes"
        final_video = _mux_tts_audio(
            video_path=fallback_video,
            audio_paths=audio_paths,
            package_dir=package_dir,
            ffmpeg_path=shutil.which("ffmpeg"),
            runner=runner,
            metadata=metadata,
            target_duration_seconds=mux_target_duration_seconds,
        )
        metadata["video"] = str(final_video)
        _write_metadata(metadata_path, metadata)
        return VideoRenderResult(final_video, composition_dir, metadata_path, skills.metadata_path, True)

    output_path = package_dir / "manual_video_agent_usage.mp4"
    command = _split_command(settings.hyperframes_command)
    if command:
        resolved = shutil.which(command[0])
        if resolved:
            command[0] = resolved
    if not command:
        metadata["status"] = "skipped"
        metadata["reason"] = "hyperframes command is empty"
        final_video = _mux_tts_audio(
            video_path=fallback_video,
            audio_paths=audio_paths,
            package_dir=package_dir,
            ffmpeg_path=shutil.which("ffmpeg"),
            runner=runner,
            metadata=metadata,
            target_duration_seconds=mux_target_duration_seconds,
        )
        metadata["video"] = str(final_video)
        _write_metadata(metadata_path, metadata)
        return VideoRenderResult(final_video, composition_dir, metadata_path, skills.metadata_path, True)

    ffmpeg_path = shutil.which("ffmpeg")
    metadata["ffmpeg_path"] = ffmpeg_path or ""
    if not ffmpeg_path:
        metadata["status"] = "failed"
        metadata["reason"] = "ffmpeg not found"
        _record_audio_mux_skip(metadata, audio_paths, reason="ffmpeg not found")
        _write_metadata(metadata_path, metadata)
        return VideoRenderResult(fallback_video, composition_dir, metadata_path, skills.metadata_path, True)

    args = [*command, str(composition_dir), "--output", str(output_path)]
    use_shell = _requires_windows_shell(args)
    runner_args: list[str] | str = subprocess.list2cmdline(args) if use_shell else args
    metadata["command"] = args
    metadata["shell"] = use_shell
    if isinstance(runner_args, str):
        metadata["shell_command"] = runner_args
    try:
        completed = runner(runner_args, cwd=str(composition_dir), capture_output=True, text=True, timeout=600, shell=use_shell)
        metadata["returncode"] = completed.returncode
        metadata["stdout"] = completed.stdout[-4000:] if completed.stdout else ""
        metadata["stderr"] = completed.stderr[-4000:] if completed.stderr else ""
        if completed.returncode == 0 and output_path.exists():
            metadata["status"] = "completed"
            metadata["used_fallback"] = False
            final_video = _mux_tts_audio(
                video_path=output_path,
                audio_paths=audio_paths,
                package_dir=package_dir,
                ffmpeg_path=ffmpeg_path,
                runner=runner,
                metadata=metadata,
                target_duration_seconds=mux_target_duration_seconds,
            )
            metadata["video"] = str(final_video)
            _write_metadata(metadata_path, metadata)
            return VideoRenderResult(final_video, composition_dir, metadata_path, skills.metadata_path, False)
        metadata["status"] = "failed"
        metadata["reason"] = "command did not produce output video"
    except Exception as exc:  # noqa: BLE001 - optional external renderer.
        metadata["status"] = "failed"
        metadata["error"] = f"{type(exc).__name__}: {exc}"

    final_video = _mux_tts_audio(
        video_path=fallback_video,
        audio_paths=audio_paths,
        package_dir=package_dir,
        ffmpeg_path=ffmpeg_path,
        runner=runner,
        metadata=metadata,
        target_duration_seconds=mux_target_duration_seconds,
    )
    metadata["video"] = str(final_video)
    _write_metadata(metadata_path, metadata)
    return VideoRenderResult(final_video, composition_dir, metadata_path, skills.metadata_path, True)


def _mux_tts_audio(
    *,
    video_path: Path,
    audio_paths: list[Path],
    package_dir: Path,
    ffmpeg_path: str | None,
    runner: CommandRunner,
    metadata: dict[str, Any],
    target_duration_seconds: float = 0.0,
) -> Path:
    existing_audio = [path for path in audio_paths if path.exists() and path.stat().st_size > 0]
    if not existing_audio:
        metadata["audio"] = {
            "status": "skipped",
            "reason": "no_tts_audio",
            "input_count": len(audio_paths),
        }
        return video_path
    if not ffmpeg_path:
        _record_audio_mux_skip(metadata, existing_audio, reason="ffmpeg not found")
        return video_path

    mix_dir = package_dir / "audio_mix"
    mix_dir.mkdir(parents=True, exist_ok=True)
    concat_list = mix_dir / "tts_concat.txt"
    narration_wav = mix_dir / "narration.wav"
    concat_list.write_text("\n".join(_concat_file_line(path) for path in existing_audio), encoding="utf-8")
    concat_args = [
        ffmpeg_path,
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(concat_list),
        "-ac",
        "2",
        "-ar",
        "48000",
        str(narration_wav),
    ]
    audio_metadata: dict[str, Any] = {
        "status": "started",
        "input_count": len(existing_audio),
        "inputs": [str(path) for path in existing_audio],
        "concat_list": str(concat_list),
        "narration": str(narration_wav),
    }
    try:
        concat_completed = runner(concat_args, cwd=str(package_dir), capture_output=True, text=True, timeout=600)
        audio_metadata["concat_returncode"] = concat_completed.returncode
        audio_metadata["concat_stdout"] = concat_completed.stdout[-2000:] if concat_completed.stdout else ""
        audio_metadata["concat_stderr"] = concat_completed.stderr[-2000:] if concat_completed.stderr else ""
        if concat_completed.returncode != 0 or not narration_wav.exists():
            audio_metadata["status"] = "failed"
            audio_metadata["reason"] = "tts audio concat failed"
            metadata["audio"] = audio_metadata
            return video_path

        output_path = package_dir / "manual_video_agent_usage.mp4"
        mux_output = package_dir / "manual_video_agent_usage.audio.tmp.mp4" if video_path.resolve() == output_path.resolve() else output_path
        video_codec_args = ["-c:v", "copy"] if video_path.suffix.lower() == ".mp4" else ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"]
        video_duration = _probe_media_duration_seconds(video_path)
        audio_duration = _probe_media_duration_seconds(narration_wav)
        leading_trim = _detect_leading_blank_seconds(
            video_path=video_path,
            ffmpeg_path=ffmpeg_path,
            package_dir=package_dir,
            runner=runner,
            video_duration_seconds=video_duration,
        )
        effective_video_duration = max(0.0, video_duration - leading_trim) if video_duration > 0 else 0.0
        requested_target_duration = _positive_float(target_duration_seconds)
        if requested_target_duration > 0:
            mux_target_duration = requested_target_duration
        else:
            mux_target_duration = max(effective_video_duration, audio_duration)
        video_extension_duration = max(0.0, mux_target_duration - effective_video_duration)
        audio_metadata["video_duration_seconds"] = round(video_duration, 3) if video_duration > 0 else None
        audio_metadata["audio_duration_seconds"] = round(audio_duration, 3) if audio_duration > 0 else None
        audio_metadata["video_leading_trim_seconds"] = round(leading_trim, 3)
        audio_metadata["mux_target_duration_seconds"] = round(mux_target_duration, 3) if mux_target_duration > 0 else None
        video_input_args = []
        if leading_trim > 0:
            video_input_args.extend(["-ss", f"{leading_trim:.3f}"])
        video_filters = []
        if video_extension_duration > 0.05:
            video_filters.append(f"tpad=stop_mode=clone:stop_duration={video_extension_duration:.3f}")
            video_codec_args = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"]
        subtitles_path = package_dir / "subtitles.vtt"
        subtitles_burned_in = subtitles_path.exists() and subtitles_path.stat().st_size > 0
        if subtitles_burned_in:
            video_filters.append("drawbox=x=0:y=ih-150:w=iw:h=150:color=white@1.0:t=fill")
            video_filters.append(_subtitles_filter(subtitles_path, package_dir=package_dir))
            video_codec_args = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"]
        video_filter_args = ["-vf", ",".join(video_filters)] if video_filters else []
        audio_metadata["subtitles_burned_in"] = subtitles_burned_in
        audio_filter_args = []
        output_duration_args = []
        if mux_target_duration > 0 and audio_duration > 0 and audio_duration < mux_target_duration:
            audio_filter_args.extend(["-af", "apad"])
        if mux_target_duration > 0 and (requested_target_duration > 0 or audio_filter_args):
            output_duration_args.extend(["-t", f"{mux_target_duration:.3f}"])
        mux_args = [
            ffmpeg_path,
            "-y",
            *video_input_args,
            "-i",
            str(video_path),
            "-i",
            str(narration_wav),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            *video_filter_args,
            *video_codec_args,
            "-c:a",
            "aac",
            *audio_filter_args,
            *output_duration_args,
            "-movflags",
            "+faststart",
            str(mux_output),
        ]
        audio_metadata["mux_command"] = mux_args
        mux_completed = runner(mux_args, cwd=str(package_dir), capture_output=True, text=True, timeout=600)
        audio_metadata["mux_returncode"] = mux_completed.returncode
        audio_metadata["mux_stdout"] = mux_completed.stdout[-2000:] if mux_completed.stdout else ""
        audio_metadata["mux_stderr"] = mux_completed.stderr[-2000:] if mux_completed.stderr else ""
        if mux_completed.returncode != 0 or not mux_output.exists():
            audio_metadata["status"] = "failed"
            audio_metadata["reason"] = "tts audio mux failed"
            metadata["audio"] = audio_metadata
            return video_path
        if mux_output != output_path:
            return_path = mux_output
        else:
            return_path = output_path
        if mux_output.name.endswith(".tmp.mp4"):
            mux_output.replace(output_path)
            return_path = output_path
        audio_metadata["status"] = "completed"
        audio_metadata["video"] = str(return_path)
        metadata["audio"] = audio_metadata
        return return_path
    except Exception as exc:  # noqa: BLE001 - narration mux should not block package generation.
        audio_metadata["status"] = "failed"
        audio_metadata["error"] = f"{type(exc).__name__}: {exc}"
        metadata["audio"] = audio_metadata
        return video_path


def _probe_media_duration_seconds(path: Path) -> float:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe or not path.exists() or path.stat().st_size <= 0:
        return 0.0
    try:
        completed = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nw=1:nk=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except Exception:
        return 0.0
    if completed.returncode != 0:
        return 0.0
    try:
        return max(0.0, float(completed.stdout.strip()))
    except ValueError:
        return 0.0


def _detect_leading_blank_seconds(
    *,
    video_path: Path,
    ffmpeg_path: str,
    package_dir: Path,
    runner: CommandRunner,
    video_duration_seconds: float,
) -> float:
    if runner is not subprocess.run or video_duration_seconds <= 2.0:
        return 0.0
    try:
        from PIL import Image, ImageStat
    except Exception:
        return 0.0

    probe_dir = package_dir / "audio_mix" / "video_probe"
    probe_dir.mkdir(parents=True, exist_ok=True)
    max_scan = min(video_duration_seconds, 60.0)
    sample_times = _blank_probe_times(max_scan)
    first_nonblank: float | None = None
    with tempfile.TemporaryDirectory(dir=str(probe_dir)) as temp_dir:
        temp_path = Path(temp_dir)
        for index, sample_time in enumerate(sample_times):
            frame_path = temp_path / f"frame_{index:03d}.png"
            args = [
                ffmpeg_path,
                "-y",
                "-ss",
                f"{sample_time:.3f}",
                "-i",
                str(video_path),
                "-frames:v",
                "1",
                "-update",
                "1",
                str(frame_path),
            ]
            try:
                completed = subprocess.run(args, cwd=str(package_dir), capture_output=True, text=True, timeout=30)
            except Exception:
                continue
            if completed.returncode != 0 or not frame_path.exists() or frame_path.stat().st_size <= 0:
                continue
            try:
                with Image.open(frame_path) as image:
                    stat = ImageStat.Stat(image.convert("RGB").resize((64, 36)))
                    mean = sum(stat.mean) / len(stat.mean)
                    variance = sum(stat.var) / len(stat.var)
            except Exception:
                continue
            if not _is_visually_blank_frame(mean=mean, variance=variance):
                first_nonblank = sample_time
                break
    if first_nonblank is None or first_nonblank < 1.0:
        return 0.0
    return max(0.0, min(first_nonblank - 0.5, video_duration_seconds - 0.5))


def _blank_probe_times(max_scan_seconds: float) -> list[float]:
    times: list[float] = []
    current = 0.0
    while current <= max_scan_seconds:
        times.append(round(current, 3))
        current += 1.0 if current < 8.0 else 2.0
    return times


def _is_visually_blank_frame(*, mean: float, variance: float) -> bool:
    return variance < 4.0 and (mean > 244.0 or mean < 12.0)


def _record_audio_mux_skip(metadata: dict[str, Any], audio_paths: list[Path], *, reason: str) -> None:
    metadata["audio"] = {
        "status": "failed" if audio_paths else "skipped",
        "reason": reason if audio_paths else "no_tts_audio",
        "input_count": len(audio_paths),
        "inputs": [str(path) for path in audio_paths],
    }


def _subtitles_filter(path: Path, *, package_dir: Path) -> str:
    try:
        relative = path.resolve().relative_to(package_dir.resolve())
        filter_path = relative.as_posix()
    except ValueError:
        filter_path = path.resolve().as_posix().replace(":", "\\:")
    filter_path = filter_path.replace("\\", "/").replace("'", "\\'")
    style = "FontName=Arial,FontSize=20,Outline=2,Shadow=1,MarginV=36,Alignment=2"
    return f"subtitles='{filter_path}':force_style='{style}'"


def _concat_file_line(path: Path) -> str:
    normalized = str(path.resolve()).replace("\\", "/").replace("'", "'\\''")
    return f"file '{normalized}'"


def _composition_timing(plan: dict[str, Any], audio_paths: list[Path]) -> tuple[float, str, list[float]]:
    steps = [step for step in plan.get("steps", []) if isinstance(step, dict)]
    step_count = max(1, len(steps))
    planned_durations = [_positive_float(step.get("duration_seconds")) for step in steps]
    target_duration = _positive_float(plan.get("target_duration_seconds"))
    if any(duration > 0 for duration in planned_durations):
        durations = [round(duration if duration > 0 else 1.0, 3) for duration in planned_durations]
        duration_seconds = round(max(target_duration, sum(durations), 1.0), 3)
        if target_duration > 0:
            duration_delta = duration_seconds - sum(durations)
            if durations:
                durations[-1] = round(max(0.1, durations[-1] + duration_delta), 3)
        source = str(plan.get("duration_source") or "media_plan_duration")
        return duration_seconds, source, durations
    if target_duration > 0:
        durations = _distribute_duration_seconds(target_duration, step_count)
        source = str(plan.get("duration_source") or "target_video_duration")
        return round(target_duration, 3), source, durations
    audio_durations = [_wav_duration_seconds(path) for path in audio_paths]
    if any(duration > 0 for duration in audio_durations):
        durations = [
            round(duration if duration > 0 else 1.0, 3)
            for duration in audio_durations[:step_count]
        ]
        if len(durations) < step_count:
            durations.extend([1.0] * (step_count - len(durations)))
        return round(max(1.0, sum(durations)), 3), "tts_audio", durations
    fallback_duration = float(max(6, min(90, step_count * 4)))
    return fallback_duration, "step_count", [round(fallback_duration / step_count, 3)] * step_count


def _positive_float(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0.0
    return parsed if parsed > 0 else 0.0


def _distribute_duration_seconds(total_seconds: float, count: int) -> list[float]:
    count = max(1, count)
    base = float(total_seconds) / float(count)
    durations = [round(base, 3)] * count
    correction = round(float(total_seconds) - sum(durations), 3)
    durations[-1] = round(durations[-1] + correction, 3)
    return durations


def _wav_duration_seconds(path: Path) -> float:
    if not path.exists() or path.stat().st_size <= 0:
        return 0.0
    try:
        with wave.open(str(path), "rb") as handle:
            frame_rate = handle.getframerate()
            if frame_rate <= 0:
                return 0.0
            return float(handle.getnframes()) / float(frame_rate)
    except Exception:
        return 0.0


def _write_hyperframes_composition(
    plan: dict[str, Any],
    package_dir: Path,
    preview_html: Path,
    fallback_video: Path,
    *,
    duration_seconds: float,
    duration_source: str,
    step_durations: list[float],
) -> Path:
    composition_dir = package_dir / "hyperframes"
    composition_dir.mkdir(parents=True, exist_ok=True)
    source_video = Path(os.path.relpath(fallback_video, composition_dir)).as_posix()
    source_preview = Path(os.path.relpath(preview_html, composition_dir)).as_posix()
    captions = _caption_entries(plan, duration_seconds, step_durations)
    captions_json = json.dumps(captions, ensure_ascii=False).replace("</", "<\\/")
    slides = []
    for index, step in enumerate(plan.get("steps", []), start=1):
        slides.append(
            f"""
            <section class="scene" data-step-id="{_escape(str(step.get('id', index)))}">
              <p class="kicker">Step {index:02d}</p>
              <h2>{_escape(str(step.get('title', '단계')))}</h2>
              <p>{_escape(str(step.get('caption', '')))}</p>
            </section>
            """
        )
    html = f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=1920, height=1080" />
  <title>Manual Video Agent HyperFrames Composition</title>
  <style>
    body {{ margin: 0; width: 1920px; height: 1080px; overflow: hidden; font-family: Pretendard, Inter, system-ui, sans-serif; background: #f7f9fc; color: #050816; }}
    [data-composition-id] {{ width: 1920px; height: 1080px; display: grid; grid-template-columns: 1fr 440px; gap: 0; background: linear-gradient(135deg, #f8fbff, #eef4ff); }}
    .stage {{ position: relative; margin: 54px 0 54px 54px; border: 1px solid #d8e0ec; border-radius: 8px; overflow: hidden; background: #ffffff; box-shadow: 0 30px 86px rgba(17,24,39,.16); }}
    .manual-source-video {{ width: 100%; height: 100%; object-fit: cover; display: block; background: #ffffff; }}
    .manual-video-pointer {{ position: absolute; right: 116px; bottom: 108px; width: 28px; height: 28px; pointer-events: none; filter: drop-shadow(0 8px 16px rgba(17,24,39,.32)); }}
    .manual-video-pointer::before {{ content: ""; position: absolute; left: 0; top: 0; width: 0; height: 0; border-left: 22px solid #111827; border-top: 13px solid transparent; border-bottom: 13px solid transparent; transform: rotate(-34deg); transform-origin: 0 50%; }}
    .manual-video-pointer::after {{ content: ""; position: absolute; left: 14px; top: 14px; width: 10px; height: 10px; border-radius: 999px; background: #21d4fd; border: 2px solid #fff; box-shadow: 0 0 0 7px rgba(33,212,253,.18); }}
    .manual-video-caption {{ position: absolute; left: 48px; right: 48px; bottom: 42px; z-index: 6; display: grid; gap: 8px; padding: 20px 24px; border: 1px solid rgba(255,255,255,.62); border-radius: 8px; background: rgba(5,8,22,.82); color: #fff; box-shadow: 0 24px 70px rgba(5,8,22,.38); backdrop-filter: blur(10px); }}
    .manual-video-caption-title {{ margin: 0; color: #21d4fd; font-size: 16px; font-weight: 900; line-height: 1.25; }}
    .manual-video-caption-text {{ margin: 0; font-size: 28px; font-weight: 850; line-height: 1.35; }}
    aside {{ padding: 54px 42px; border-left: 1px solid #d8e0ec; display: flex; flex-direction: column; gap: 18px; }}
    aside .dot {{ width: 16px; height: 16px; border-radius: 999px; background: #21d4fd; box-shadow: 0 0 36px rgba(33,212,253,.72); }}
    aside h1 {{ margin: 14px 0 6px; font-size: 42px; line-height: 1.08; }}
    aside p {{ margin: 0; font-size: 18px; line-height: 1.5; color: #465161; }}
    .steps {{ display: grid; gap: 14px; margin-top: 10px; max-height: 730px; overflow: hidden; }}
    .scene {{ padding: 18px; border: 1px solid #d8e0ec; border-radius: 8px; background: rgba(255,255,255,.9); box-shadow: 0 16px 38px rgba(17,24,39,.07); }}
    .kicker {{ margin: 0 0 10px; color: #245bff; font-size: 13px; font-weight: 800; }}
    h2 {{ margin: 0 0 8px; font-size: 22px; line-height: 1.2; }}
    .scene p:last-child {{ margin: 0; font-size: 16px; line-height: 1.45; color: #465161; }}
  </style>
</head>
<body>
  <div data-composition-id="manual-video-agent" data-duration="{duration_seconds:.3f}" data-fps="30">
    <div class="stage">
      <video class="manual-source-video" src="{_escape(source_video)}" muted autoplay loop playsinline></video>
      <div class="manual-video-pointer"></div>
      <div class="manual-video-caption" aria-live="polite">
        <p class="manual-video-caption-title">{_escape(captions[0]['title']) if captions else ''}</p>
        <p class="manual-video-caption-text">{_escape(captions[0]['caption']) if captions else ''}</p>
      </div>
    </div>
    <aside>
      <div class="dot"></div>
      <h1>Manual Video Agent</h1>
      <p>Playwright 녹화 영상을 HyperFrames composition의 1차 소스로 사용합니다.</p>
      <p>Source: {_escape(source_preview)}</p>
      <div class="steps">{''.join(slides)}</div>
    </aside>
  </div>
  <script>
    const manualVideoCaptions = {captions_json};
    const updateManualVideoCaption = () => {{
      const video = document.querySelector('.manual-source-video');
      const title = document.querySelector('.manual-video-caption-title');
      const text = document.querySelector('.manual-video-caption-text');
      if (!video || !title || !text || !manualVideoCaptions.length) return;
      const duration = Number(video.duration || {duration_seconds:.3f}) || {duration_seconds:.3f};
      const current = Number(video.currentTime || 0) % Math.max(duration, 0.1);
      const active = manualVideoCaptions.find((item) => current >= item.start && current < item.end)
        || manualVideoCaptions[manualVideoCaptions.length - 1];
      title.textContent = active.title || '';
      text.textContent = active.caption || active.title || '';
    }};
    const video = document.querySelector('.manual-source-video');
    if (video) {{
      video.addEventListener('loadedmetadata', updateManualVideoCaption);
      video.addEventListener('timeupdate', updateManualVideoCaption);
      video.addEventListener('play', updateManualVideoCaption);
      window.setInterval(updateManualVideoCaption, 250);
      updateManualVideoCaption();
    }}
  </script>
</body>
</html>"""
    (composition_dir / "index.html").write_text(html, encoding="utf-8")
    (composition_dir / "hyperframes_manifest.json").write_text(
        json.dumps(
            {
                "composition_id": "manual-video-agent",
                "source_preview": str(preview_html),
                "source_video": str(fallback_video),
                "source_video_relative": source_video,
                "duration_seconds": duration_seconds,
                "duration_source": duration_source,
                "captions": captions,
                "steps": len(slides),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return composition_dir


def _caption_entries(plan: dict[str, Any], duration_seconds: float, step_durations: list[float]) -> list[dict[str, Any]]:
    steps = [step for step in plan.get("steps", []) if isinstance(step, dict)]
    if not steps:
        return []
    total = max(float(duration_seconds), 0.1)
    captions: list[dict[str, Any]] = []
    current = 0.0
    for index, step in enumerate(steps):
        duration = step_durations[index] if index < len(step_durations) else total / len(steps)
        start = round(current, 3)
        current = total if index == len(steps) - 1 else min(total, current + max(float(duration), 0.1))
        end = round(current, 3)
        title = str(step.get("title") or f"Step {index + 1}")
        caption = str(step.get("caption") or step.get("narration") or title)
        captions.append(
            {
                "step_id": str(step.get("id") or f"step_{index + 1}"),
                "title": title,
                "caption": caption,
                "start": start,
                "end": end,
            }
        )
    return captions


def _split_command(command: str) -> list[str]:
    return shlex.split(command, posix=False)


def _requires_windows_shell(args: list[str]) -> bool:
    if os.name != "nt" or not args:
        return False
    suffix = Path(args[0]).suffix.lower()
    return suffix in {".cmd", ".bat"}


def _write_metadata(path: Path, metadata: dict[str, Any]) -> None:
    path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def _escape(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
