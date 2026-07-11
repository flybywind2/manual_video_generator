from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from backend.app.workflow import WorkflowStep


@dataclass(frozen=True)
class WorkflowNode:
    step: str
    actor: str
    label: str
    next_steps: tuple[str, ...] = ()
    optional: bool = False


class WorkflowGraph:
    def __init__(self, nodes: Iterable[WorkflowNode]) -> None:
        self._nodes = tuple(nodes)
        self._by_step = {node.step: node for node in self._nodes}

    def has_step(self, step: str) -> bool:
        return step in self._by_step

    def node(self, step: str) -> WorkflowNode:
        return self._by_step[step]

    def ordered_steps(self) -> list[str]:
        return [node.step for node in self._nodes]

    def next_steps(self, step: str) -> list[str]:
        node = self._by_step.get(step)
        return list(node.next_steps) if node else []

    def transition_allowed(self, current_step: str, next_step: str) -> bool:
        if next_step not in self._by_step:
            return False
        if not current_step:
            return True
        if current_step not in self._by_step:
            return False
        if current_step == next_step:
            return True
        return next_step in self._by_step[current_step].next_steps

    def metadata(self) -> dict[str, object]:
        return {
            "name": "manual-video-agent-workflow",
            "version": 2,
            "nodes": [
                {
                    "step": node.step,
                    "actor": node.actor,
                    "label": node.label,
                    "next_steps": list(node.next_steps),
                    "optional": node.optional,
                }
                for node in self._nodes
            ],
        }


WORKFLOW_GRAPH = WorkflowGraph(
    [
        WorkflowNode(
            step=WorkflowStep.REQUEST_VALIDATION,
            actor="pipeline",
            label="요청 검증",
            next_steps=(WorkflowStep.BROWSER_SESSION, WorkflowStep.EXECUTION_FAILED),
        ),
        WorkflowNode(
            step=WorkflowStep.PLAN_REVIEW,
            actor="approval",
            label="요청 검수",
            next_steps=(WorkflowStep.BROWSER_SESSION, WorkflowStep.EXECUTION_FAILED),
        ),
        WorkflowNode(
            step=WorkflowStep.BROWSER_SESSION,
            actor="browser_session",
            label="Edge CDP 세션",
            next_steps=(WorkflowStep.OPENCODE_DISCOVERY, WorkflowStep.EXECUTION_FAILED),
        ),
        WorkflowNode(
            step=WorkflowStep.OPENCODE_DISCOVERY,
            actor="opencode",
            label="OpenCode 브라우저 탐색",
            next_steps=(WorkflowStep.TRACE_VALIDATION, WorkflowStep.EXECUTION_FAILED),
        ),
        WorkflowNode(
            step=WorkflowStep.TRACE_VALIDATION,
            actor="trace_validation",
            label="실행 추적 검증",
            next_steps=(WorkflowStep.TTS, WorkflowStep.EXECUTION_FAILED),
        ),
        WorkflowNode(
            step=WorkflowStep.TTS,
            actor="tts",
            label="Supertonic 음성 생성",
            next_steps=(WorkflowStep.REPLAY, WorkflowStep.EXECUTION_FAILED),
        ),
        WorkflowNode(
            step=WorkflowStep.REPLAY,
            actor="replay",
            label="음성 동기화 재생",
            next_steps=(WorkflowStep.MASKING, WorkflowStep.EXECUTION_FAILED),
        ),
        WorkflowNode(
            step=WorkflowStep.MASKING,
            actor="masking",
            label="마스킹",
            next_steps=(WorkflowStep.PREVIEW, WorkflowStep.EXECUTION_FAILED),
        ),
        WorkflowNode(
            step=WorkflowStep.PREVIEW,
            actor="preview",
            label="미리보기와 문서 생성",
            next_steps=(WorkflowStep.RENDER, WorkflowStep.EXECUTION_FAILED),
        ),
        WorkflowNode(
            step=WorkflowStep.RENDER,
            actor="render",
            label="영상 렌더",
            next_steps=(WorkflowStep.MANIFEST, WorkflowStep.EXECUTION_FAILED),
        ),
        WorkflowNode(
            step=WorkflowStep.MANIFEST,
            actor="manifest",
            label="패키지 매니페스트",
            next_steps=(WorkflowStep.COMPLETED, WorkflowStep.EXECUTION_FAILED),
        ),
        WorkflowNode(
            step=WorkflowStep.EXECUTION_FAILED,
            actor="pipeline",
            label="실행 실패",
            next_steps=(WorkflowStep.BROWSER_SESSION,),
        ),
        WorkflowNode(
            step=WorkflowStep.COMPLETED,
            actor="pipeline",
            label="완료",
            next_steps=(),
        ),
    ]
)
