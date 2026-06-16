# Evaluation Harness

This module instantiates a public task bundle into an isolated run directory,
runs one source-native Claude Code `QueryEngine` session, executes hidden judge
attempts, and writes compact JSONL trajectories for later skill extraction.

## Source-Native Architecture

The harness entrypoint calls `runSourceTaskLoop`, which creates exactly one `SourceClaudeSessionAgent` for the run. That session
constructs `QueryEngine` directly from the local Claude source and reuses it
across judge feedback rounds.

Per run:

1. `createTaskRun` copies only public task files into `runs/<run_id>/public`.
2. `resolveTaskRuntime` verifies the task Python before agent startup.
3. `SourceClaudeSessionAgent` builds a minimal tool pool from Claude source
   tools plus the in-process `finalize_submission` tool.
4. `createHarnessCanUseTool` enforces run-local read/write policy for tool use.
5. `DefaultJudgeRunner` copies private judge assets into `.judge_private` only
   when a judge attempt is triggered.

Batch mode is source-only: repeated `--task` values are dispatched as one worker
process per run. The removed legacy runtime is rejected explicitly.

## Loop Semantics

`max_rounds` means maximum judge attempts, not maximum agent tool calls. A judge
attempt is triggered only when the agent calls `finalize_submission` and output
validation passes against the public output contract. Validation failures are
returned as recoverable tool feedback and do not consume a judge round.

Natural-language messages such as "done" are ignored. If an agent turn ends
without a passing `finalize_submission`, the harness gives exactly one
same-round no-finalize recovery prompt. Recovery does not auto-validate,
auto-submit, or auto-judge; if it still ends without a passing
`finalize_submission`, the run fails or times out without a judge attempt.

Missing `workspace/plan.md` or `workspace/plans/round_NN.md` files are recorded
as warnings, not hard blockers, when outputs are otherwise valid.

## Task Visibility

Agent-visible paths are limited to the current run:

- `public/`: read-only public task bundle.
- `workspace/`: writable solver code, notes, and scratch files.
- `outputs/`: writable final submission files.
- `logs/agent/`: writable agent logs.

Private `evaluation/`, `std_code/`, reference output, and judge data paths are
not copied into the agent-visible workspace. They are available only to the
external judge under `runs/.judge_private/<run_id>/`.

The initial prompt now includes a compact public file manifest, output contract,
visible case summary, and the full public README. No `public/HARNESS_HINTS.md`
file is generated.

## Runtime Resolution

The harness resolves Python once before creating the Claude session. It reads
`public/envs/env_manifest.json`, chooses the platform-specific Python path, and
falls back to conventional runtime locations:

- Windows: `public/envs/runtime/.venv/Scripts/python.exe`
- POSIX/WSL: `public/envs/runtime/.venv/bin/python`
- POSIX/WSL alternate: `public/envs/runtime/.venv-posix/bin/python`

If no runtime exists, the run exits as `infra_error`; the agent is not asked to
repair virtual environments or install packages.

Virtual-environment directories are linked into the run instead of copied, so a
run does not spend minutes duplicating `site-packages`.

## Trajectories

`SourceTrajectoryWriter` writes two append-only files:

- `logs/trajectory.clean.jsonl`: compact training-friendly records.
- `logs/trajectory.raw.jsonl`: raw source events for debugging.

Static context is written once as `run_context`. Judge feedback is compacted
before being sent as a continuation prompt in the same session, while the raw
judge JSON stays in `trajectory.raw.jsonl` for debugging.

Clean trajectories also record validation pass/fail events, run warnings, and
no-finalize recovery markers. Raw trajectories preserve source events exactly;
clean trajectories filter standalone punctuation-only assistant text such as
`.` or `...`.

## CLI

```bash
bun src/harness/evaluation/cli.ts --task <task_id> --runs-dir output/runs --max-rounds 3 --timeout-seconds 1800 --temperature 1 --thinking disabled
```

`--system-prompt <path>` is a debug-only explicit override. Normal source-native
runs use the built-in lean system contract plus the generated initial prompt;
there is no default `config/AGENT.md`.

The default LLM options are `--thinking disabled --temperature 1`. With
thinking disabled, temperature is sent to the model. With `--thinking adaptive`,
temperature is intentionally omitted and logged as ignored in run metadata.

`--max-turns-per-round <n>` caps agentic turns within one judge round. It is
optional; full implementation regressions usually leave it unset and rely on
`--timeout-seconds` as the whole-loop hard timeout. Set a cap when diagnosing
no-finalize loops or running short smoke tests.
