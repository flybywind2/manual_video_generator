# Gemma 4 12B QAT Video Prompt Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create and validate role-specific prompts that let local Ollama `gemma4:12b_qat` produce parser-compatible manual-video plans and browser actions.

**Architecture:** Keep the existing FastAPI, Playwright, TTS, and render pipeline unchanged. Define separate contracts for input extraction, planning, DOM browser action, and screenshot-assisted browser action, then validate representative responses against the current parsers and action schemas.

**Tech Stack:** Markdown, Ollama OpenAI-compatible API, Python 3.13.14 JSON contracts, Playwright action schema

---

### Task 1: Document prompt boundaries

**Files:**
- Create: `docs/plans/2026-07-10-gemma4-12b-qat-video-prompt-design.md`

**Step 1:** Record the current prompt call sites and parser contracts.

**Step 2:** Separate prompt-solvable behavior from MCP, renderer, TTS, and duration configuration.

**Step 3:** Review the design against the latest generated package evidence.

### Task 2: Write the role-specific prompt pack

**Files:**
- Create: `docs/prompts/gemma4_12b_qat_video_generation.md`

**Step 1:** Write the Input Extractor prompt with an exact JSON schema and sensitive-value exclusion.

**Step 2:** Write the Planner prompt with evidence-bounded narration and valid action types.

**Step 3:** Write the DOM Browser Agent prompt with one-action observe-act-verify rules.

**Step 4:** Write the VLM Browser Agent prompt with screenshot and DOM cross-check rules.

**Step 5:** Add an operator request template and runtime preflight configuration.

### Task 3: Validate with local Ollama

**Files:**
- Validate: `docs/prompts/gemma4_12b_qat_video_generation.md`

**Step 1:** Send the sample input-extraction request to `http://127.0.0.1:11434/v1/chat/completions`.

Expected: one JSON object containing only non-sensitive screen input values.

**Step 2:** Send the sample planner context.

Expected: non-empty `steps` and `actions`, no invented UI names, and valid step references.

**Step 3:** Send representative DOM observations for navigation, fill, submit, wait, capture, and finish turns.

Expected: exactly one valid action per response, using only observed text or selectors.

**Step 4:** Parse every response with the same strict JSON assumptions as the production adapters.

**Step 5:** Record measured response time and any contract failures in the prompt document.
