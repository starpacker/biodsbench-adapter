# BioDSBench Adapter

Source-native evaluation harness for running Claude Code agents on **imaging-101**, **BioDSBench**, and **BioMniBench** tasks. Supports advanced features like **true-serial mode** with prior-subtask context propagation and the **Oracle Skills** distillation + priority-greedy ablation pipeline.

---

## Features

- **Source-native agent evaluation**: Run tasks with the local Claude Code source, preserving tool state and conversation context across judge feedback rounds.
- **True-serial mode**: Pass prior subtask results (code, status, judge feedback) to subsequent tasks in a multi-subtask workflow, enabling models to learn from earlier attempts.
- **Oracle Skills ablation** (new in v1.1.0): Distil a task's reference implementation into 8–14 atomic operations and use **priority-greedy ablation** to identify the minimal core knowledge a solver actually needs. See [Oracle Skills](#oracle-skills-distillation--ablation) below.
- **Multiple benchmark adapters**:
  - `imaging-101` tasks (e.g., `conventional_ptychography`, `ct_dual_energy`, `mri_grappa`)
  - BioDSBench Python data-science tasks (118 biomedical analysis scenarios)
  - BioMniBench Docker-style `da-*` tasks
- **Pipelined batch runner**: Execute task sets with fixed concurrency.
- **TypeScript + Bun runtime**.

---

## Quick Start — One-Shot Bootstrap

```bash
git clone https://github.com/starpacker/biodsbench-adapter.git
cd biodsbench-adapter

# Optional (mainland China users):
# export HF_ENDPOINT=https://hf-mirror.com

bash scripts/bootstrap.sh        # ~10 min: installs deps, clones dataset,
                                 # builds conda env, wires every task .venv
```

`scripts/bootstrap.sh` will:
1. Verify `bun`, `conda`, `git`, `python3` are present.
2. `bun install --frozen-lockfile`.
3. `pip install --user huggingface_hub`.
4. `git clone` the [BioDSBench-imaging101-format](https://huggingface.co/datasets/starpacker52/BioDSBench-imaging101-format) HF dataset (with LFS smudge) into `./biodsbench-data`.
5. `conda env create -f environment.yml -n biodsbench`.
6. `python scripts/setup_task_venvs.py --shared-conda biodsbench --tasks-dir biodsbench-data/tasks` — symlinks every task's stub `.venv` to the shared conda env.

After bootstrap, **set credentials** and run any task:

```bash
export ANTHROPIC_API_KEY="sk-..."
export ANTHROPIC_BASE_URL="https://api.anthropic.com"   # or your proxy
export ANTHROPIC_MODEL="claude-opus-4"

bun src/harness/evaluation/cli.ts \
  --task 25303977_0 \
  --tasks-dir biodsbench-data/tasks \
  --runs-dir output/runs \
  --max-rounds 2
```

> ℹ️ **Why bootstrap?** The HF dataset ships each task's `envs/runtime/.venv/` as **stubs** (only `bin/python` placeholders). The framework requires a real Python interpreter with `pandas`, `numpy`, etc., available at that path. `setup_task_venvs.py` solves this in one of three ways: shared conda symlinks (default & fastest), per-task `venv + pip install`, or `--check` for audit.

---

## Manual / Advanced Setup

### Prerequisites

- **Bun** 1.0+: [Install Bun](https://bun.sh)
- **Conda** (miniconda or anaconda)
- **Python** 3.10+
- **LLM API access** (Anthropic-compatible)

### Step-by-step

```bash
# 1. JS deps
bun install

# 2. Python deps (huggingface_hub for dataset)
pip install -r requirements.txt

# 3. Clone dataset (use HF_ENDPOINT=https://hf-mirror.com if in mainland China)
git lfs install
git clone https://huggingface.co/datasets/starpacker52/BioDSBench-imaging101-format \
  biodsbench-data

# 4. Build shared task env
conda env create -f environment.yml -n biodsbench

# 5. Wire task .venv -> shared conda env
python scripts/setup_task_venvs.py \
  --shared-conda biodsbench \
  --tasks-dir biodsbench-data/tasks

# (Optional) verify
python scripts/setup_task_venvs.py --check --tasks-dir biodsbench-data/tasks
```

### Run a single task

```bash
bun src/harness/evaluation/cli.ts \
  --task 25303977_0 \
  --tasks-dir biodsbench-data/tasks \
  --runs-dir output/runs \
  --max-rounds 2
```

### Run imaging-101 tasks

```bash
bun src/harness/evaluation/cli.ts \
  --task mri_grappa \
  --runs-dir output/runs \
  --max-rounds 5 \
  --timeout-seconds 2400
```

---

## True-Serial Mode (Advanced)

See `examples/run_imaging101_true_serial.py`:

```bash
export LLM_API_KEY="your-api-key"
python3 examples/run_imaging101_true_serial.py \
  --study-id 25303977 \
  --start 0 \
  --end 7 \
  --max-rounds 2
```

Each subtask receives a `--prior-context` JSON file with descriptions, code, and judge feedback from earlier subtasks.

**Docs**: `examples/ARCHITECTURE.md` · `examples/EFFECTIVENESS_REPORT.md`

---

## Oracle Skills (distillation + ablation)

The `src/oracle-skills/` module turns a task's reference implementation (`std_code/`) into a portable **Claude Skill bundle** and runs **priority-greedy ablation** to identify which knowledge pieces are actually critical for solving the task.

### Why

Given a baseline that passes the task with the full skill enabled, we want to know **which atomic pieces of knowledge are removable without breaking the result**. The remaining (non-removable) operations are the *minimal core knowledge*.

### How

1. **Author** — an offline LLM author reads `std_code/` and produces a structured draft of **8–14 atomic operations** (each with `id`, `title`, `kind`, `depends_on`, `ablation_priority`, owned `resources/` and `scripts/`). A deterministic `template` mode is also available for smoke-testing the pipeline without LLM calls.
2. **Materialize** — operations are written out as a Claude Skill: `skills/<skill>/SKILL.md` with `<!-- ORACLE_OP_START ... -->` anchors, plus `resources/` and `scripts/` directories.
3. **Render** — each variant is produced by removing a set of operations (their anchored block + owned assets). Remaining resources/scripts are renamed to `resource_001.md`, `script_001.py`, etc., so the variant cannot leak which ops were dropped.
4. **Ablate** — priority-greedy sweep: ops are sorted by `ablation_priority` descending; for each candidate, evaluate the variant; if it **passes**, add it to the cumulative drop set; if it **fails or is inconclusive**, keep the op. The final `acceptedDropOps` is the set of *removable* knowledge; everything else is *core*.

### Quick start

```bash
# Template mode — no LLM, deterministic; good for verifying the pipeline
python examples/oracle_skills_biodsbench.py \
    --dataset /path/to/BioDSBench-imaging101-format \
    --task 25303977_0 \
    --out output/oracle-skills/25303977_0 \
    --mode template \
    --dry-run-ablation
```

Outputs a bundle, validates it, and lists candidate variants:

```text
=== [1/3] Generate bundle (mode=template) ===
{
  "bundleDir": "output/oracle-skills/25303977_0",
  "skillName": "oracle-25303977_0",
  "operationIds": [
    "op_010_current_contract", "op_020_io_and_data",
    "op_030_reference_knowledge", "op_040_solver_flow",
    "op_050_output_validation"
  ],
  "mode": "template"
}

=== [2/3] Validate bundle ===
{ "ok": true, "issues": [] }

=== [3/3] Ablation (dry-run) ===
Candidate variants (11):
  - v_c098aabd6f98 kind=full
  - v_a083de7435b4 kind=single_drop  drop=op_020_io_and_data
  - v_b768556df0eb kind=single_drop  drop=op_040_solver_flow
  ...
```

For a real research run with an LLM author (Claude or any Anthropic-compatible endpoint):

```bash
export LLM_API_KEY=<your-key>
python examples/oracle_skills_biodsbench.py \
    --dataset /path/to/BioDSBench-imaging101-format \
    --task 25303977_0 \
    --out output/oracle-skills/25303977_0 \
    --mode query-engine \
    --max-operations 12 \
    --ablate
```

### Direct CLI usage

The Python wrapper just calls the TypeScript CLI; for fine control use it directly:

```bash
# 1. Preview the author prompt only (no LLM call)
bun src/oracle-skills/cli.ts prompt \
    --task 25303977_0 \
    --tasks-dir /path/to/BioDSBench-imaging101-format/tasks \
    --out output/oracle-prompts/25303977_0

# 2. Generate (template = deterministic, no LLM)
bun src/oracle-skills/cli.ts generate \
    --task 25303977_0 \
    --tasks-dir /path/to/BioDSBench-imaging101-format/tasks \
    --out output/oracle-skills/25303977_0 \
    --mode template

# 3. Validate
bun src/oracle-skills/cli.ts validate --bundle output/oracle-skills/25303977_0

# 4. Render a variant with specific ops removed
bun src/oracle-skills/cli.ts render \
    --bundle output/oracle-skills/25303977_0 \
    --out output/variants/manual-v1 \
    --drop-ops op_050_output_validation,op_040_solver_flow

# 5. List ablation candidates without running evaluation
bun src/oracle-skills/cli.ts ablate \
    --bundle output/oracle-skills/25303977_0 \
    --out output/ablation/25303977_0 \
    --dry-run
```

### Output layout

```
output/oracle-skills/<task>/
├── oracle_skill_manifest.json       # Op definitions + dependencies + ablation priority
├── source_index.json                # Source files inspected by the author
├── author_draft.json                # Raw structured author output (query-engine mode)
└── skills/<skill_name>/
    ├── SKILL.md                     # With ORACLE_OP_START/END anchors
    ├── resources/op_NNN_*.md
    └── scripts/op_NNN_*.py

output/ablation/<task>/
├── candidate_order.json             # Sorted ablation candidates
├── ablation_results.jsonl           # One JSON line per variant evaluated
├── ablation_summary.json            # Final summary + accepted_drop_ops
├── variants/v_<hash>/skills/...     # Hashed variant dirs (no op-id leakage)
├── metadata/variants/v_<hash>.json  # Variant metadata (researcher-only)
└── eval/v_<hash>/run/.../           # Evaluation logs per variant
```

See [`docs/oracle-skills.md`](docs/oracle-skills.md) for the full design specification.

---

## Project Structure

```
biodsbench-adapter/
├── src/harness/evaluation/         # Core evaluation CLI + harness
│   ├── cli.ts                      # Main entry point
│   ├── configRunner.ts             # Config-driven runner used by oracle-skills ablate
│   ├── sourceTaskLoop.ts           # Task orchestration
│   ├── sourceRuntimeResolver.ts    # Resolves task .venv vs shared venv
│   ├── sourceContextBuilder.ts     # Prompt + prior-context injection
│   ├── networkPolicy.ts            # Per-eval network sandbox
│   └── types.ts
├── src/oracle-skills/              # Oracle skill distillation + priority-greedy ablation
│   ├── cli.ts                      # `generate / prompt / validate / render / ablate`
│   ├── ablate.ts                   # Priority-greedy ablation algorithm
│   ├── generate.ts                 # Author session orchestration (template / LLM)
│   ├── prompts.ts                  # Author system prompt & repair prompts
│   ├── schema.ts                   # JSON Schema for the structured author output
│   ├── render.ts                   # Variant rendering + asset anonymization
│   ├── manifest.ts                 # Bundle validation
│   └── materialize.ts              # Draft → on-disk skill bundle
├── docs/
│   └── oracle-skills.md            # Full Oracle Skills design specification
├── config/
│   ├── llm-config.sh.example       # API config template
│   └── task-batch-runner.json      # Batch runner config
├── scripts/
│   ├── bootstrap.sh                # One-shot setup
│   └── setup_task_venvs.py         # .venv wiring (shared-conda | per-task)
├── examples/
│   ├── run_imaging101_true_serial.py    # True-serial orchestrator
│   ├── oracle_skills_biodsbench.py      # Oracle Skills Python helper
│   ├── ARCHITECTURE.md                  # Design docs
│   └── EFFECTIVENESS_REPORT.md          # Effectiveness study
├── environment.yml                 # Shared conda env spec
├── requirements.txt                # Python bootstrap deps
└── tests/                          # Unit tests
```

---

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `--task <id>` | Task ID | (required) |
| `--tasks-dir <path>` | Task definitions root | `./tasks` |
| `--runs-dir <path>` | Output directory | `./output/runs` |
| `--max-rounds <n>` | Judge feedback rounds | `3` |
| `--timeout-seconds <n>` | Per-round timeout | `1800` |
| `--prior-context <path>` | Prior-subtask context JSON | (none) |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Python interpreter not found at .../.venv/bin/python` | Run `python scripts/setup_task_venvs.py --shared-conda biodsbench --tasks-dir biodsbench-data/tasks` |
| `ModuleNotFoundError: pandas` | Re-create conda env: `conda env create -f environment.yml -n biodsbench --force` |
| `git clone` of dataset is slow / fails | `export HF_ENDPOINT=https://hf-mirror.com` then re-run bootstrap |
| Judge says `KeyError` / `ValueError` | This is a **model code error**, not a framework error — check `output/runs/<task>/judge_result_round_1.json` |

---

## Development

```bash
bun test          # Run tests
bun run build     # Build TypeScript
```

---

## Citation

If you use this framework, please cite:

- **BioDSBench**: Hou et al., "BioDSBench: A Benchmark for Data Science Code Generation in Biology"

**Related Repositories**:
- Dataset (HF): https://huggingface.co/datasets/starpacker52/BioDSBench-imaging101-format
- Adapter mirror (HF): https://huggingface.co/starpacker52/biodsbench-adapter

---

## License

MIT License (see LICENSE file)

---

## Support

[Open an issue](https://github.com/starpacker/biodsbench-adapter/issues) for questions or bug reports.
