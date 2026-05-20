from pathlib import Path

from backend.app.env_bootstrap import build_runtime_environment, bundle_root


def test_bundle_root_prefers_explicit_environment(tmp_path: Path):
    root = tmp_path / "manualgen"

    assert bundle_root({"MANUAL_AGENT_BUNDLE_ROOT": str(root)}) == root.resolve()


def test_build_runtime_environment_points_caches_inside_bundle(tmp_path: Path):
    (tmp_path / "runtime" / "browsers").mkdir(parents=True)
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "corp-root-ca.pem").write_text("cert", encoding="utf-8")

    env = build_runtime_environment(root=tmp_path, environ={"PATH": "C:\\Windows\\System32"})

    assert env["MANUAL_AGENT_BUNDLE_ROOT"] == str(tmp_path.resolve())
    assert env["MANUAL_AGENT_OUTPUT_DIR"] == str(tmp_path / "output")
    assert env["PLAYWRIGHT_BROWSERS_PATH"] == str(tmp_path / "runtime" / "browsers")
    assert env["HF_HOME"] == str(tmp_path / "runtime" / "hf-cache")
    assert env["NPM_CONFIG_CACHE"] == str(tmp_path / "runtime" / "npm-cache")
    assert env["SUPERTONIC_CACHE_DIR"] == str(tmp_path / "runtime" / "supertonic3")
    assert env["REQUESTS_CA_BUNDLE"] == str(tmp_path / "config" / "corp-root-ca.pem")
    assert env["NODE_EXTRA_CA_CERTS"] == str(tmp_path / "config" / "corp-root-ca.pem")
    assert env["PATH"].endswith("C:\\Windows\\System32")


def test_build_runtime_environment_does_not_force_missing_playwright_browser_path(tmp_path: Path):
    env = build_runtime_environment(root=tmp_path, environ={"PATH": "C:\\Windows\\System32"})

    assert "PLAYWRIGHT_BROWSERS_PATH" not in env
    assert env["HF_HOME"] == str(tmp_path / "runtime" / "hf-cache")
    assert env["SUPERTONIC_CACHE_DIR"] == str(tmp_path / "runtime" / "supertonic3")


def test_build_runtime_environment_does_not_override_existing_cache_values(tmp_path: Path):
    env = build_runtime_environment(
        root=tmp_path,
        environ={
            "PATH": "C:\\Windows\\System32",
            "PLAYWRIGHT_BROWSERS_PATH": "D:\\cached-browsers",
            "HF_HOME": "D:\\hf",
            "NPM_CONFIG_CACHE": "D:\\npm-cache",
            "SUPERTONIC_CACHE_DIR": "D:\\supertonic3",
            "MANUAL_AGENT_OUTPUT_DIR": "D:\\manual-output",
        },
    )

    assert env["PLAYWRIGHT_BROWSERS_PATH"] == "D:\\cached-browsers"
    assert env["HF_HOME"] == "D:\\hf"
    assert env["NPM_CONFIG_CACHE"] == "D:\\npm-cache"
    assert env["SUPERTONIC_CACHE_DIR"] == "D:\\supertonic3"
    assert "MANUAL_AGENT_OUTPUT_DIR" not in env


def test_build_runtime_environment_reads_runtime_values_from_env_file(tmp_path: Path):
    (tmp_path / ".env").write_text(
        "\n".join(
            [
                "PLAYWRIGHT_BROWSERS_PATH=D:\\pw",
                "HF_HOME=D:\\hf",
                "NPM_CONFIG_CACHE=D:\\npm",
                "SUPERTONIC_CACHE_DIR=D:\\supertonic3",
            ]
        ),
        encoding="utf-8",
    )

    env = build_runtime_environment(root=tmp_path, environ={"PATH": "C:\\Windows\\System32"})

    assert env["PLAYWRIGHT_BROWSERS_PATH"] == "D:\\pw"
    assert env["HF_HOME"] == "D:\\hf"
    assert env["NPM_CONFIG_CACHE"] == "D:\\npm"
    assert env["SUPERTONIC_CACHE_DIR"] == "D:\\supertonic3"


def test_build_runtime_environment_prepends_existing_portable_bins(tmp_path: Path):
    for path in [
        tmp_path / "runtime" / "python",
        tmp_path / "runtime" / "node",
        tmp_path / "runtime" / "ffmpeg" / "bin",
    ]:
        path.mkdir(parents=True)

    env = build_runtime_environment(root=tmp_path, environ={"PATH": "C:\\Windows\\System32"})

    parts = env["PATH"].split(";")
    assert parts[:3] == [
        str(tmp_path / "runtime" / "python"),
        str(tmp_path / "runtime" / "node"),
        str(tmp_path / "runtime" / "ffmpeg" / "bin"),
    ]
    assert parts[-1] == "C:\\Windows\\System32"
