# BioDSBench Adapter

Source-native evaluation harness for running Claude Code agents on **imaging-101**, **BioDSBench**, and **BioMniBench** tasks. Supports advanced features like **true-serial mode** with prior-subtask context propagation.

---

## Features

- **Source-native agent evaluation**: Run tasks with the local Claude Code source, preserving tool state and conversation context across judge feedback rounds.
- **True-serial mode**: Pass prior subtask results (code, status, judge feedback) to subsequent tasks in a multi-subtask workflow.
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

## Project Structure

```
biodsbench-adapter/
├── src/harness/evaluation/         # Core evaluation CLI
│   ├── cli.ts                      # Main entry point
│   ├── sourceTaskLoop.ts           # Task orchestration
│   ├── sourceRuntimeResolver.ts    # Resolves task .venv vs shared venv
│   ├── sourceContextBuilder.ts     # Prompt + prior-context injection
│   └── types.ts
├── config/
│   ├── llm-config.sh.example       # API config template
│   └── task-batch-runner.json      # Batch runner config
├── scripts/
│   ├── bootstrap.sh                # One-shot setup
│   └── setup_task_venvs.py         # .venv wiring (shared-conda | per-task)
├── examples/
│   ├── run_imaging101_true_serial.py
│   ├── ARCHITECTURE.md
│   └── EFFECTIVENESS_REPORT.md
├── environment.yml                 # Shared conda env spec
├── requirements.txt                # Python bootstrap deps
└── tests/
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
