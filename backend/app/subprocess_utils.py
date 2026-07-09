from __future__ import annotations

import subprocess
from typing import Any, Callable


CommandRunner = Callable[..., subprocess.CompletedProcess]


def run_text_command(runner: CommandRunner, command: Any, **kwargs: Any) -> subprocess.CompletedProcess:
    kwargs["text"] = True
    if runner is subprocess.run:
        kwargs.setdefault("encoding", "utf-8")
        kwargs.setdefault("errors", "replace")
    return runner(command, **kwargs)
