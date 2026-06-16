# BioDSBench Adapter

Source-native evaluation harness for running Claude Code agents on **imaging-101**, **BioDSBench**, and **BioMniBench** tasks. Supports advanced features like **true-serial mode** with prior-subtask context propagation.

---

## Features

- **Source-native agent evaluation**: Run tasks with the local Claude Code source, preserving tool state and conversation context across judge feedback rounds.
- **True-serial mode**: Pass prior subtask results (code, status, judge feedback) to subsequent tasks in a multi-subtask workflow, enabling models to learn from earlier attempts.
- **Multiple benchmark adapters**:
  - `imaging-101` tasks (e.g., `conventional_ptychography`, `ct_dual_energy`, `mri_grappa`)
  - BioDSBench Python data-science tasks (118 biomedical analysis scenarios)
  - BioMniBench Docker-style `da-*` tasks
- **Pipelined batch runner**: Execute task sets with fixed concurrency, non-blocking queue management.
- **TypeScript + Bun runtime**: Fast, modern TypeScript tooling.

---

## Quick Start

### Prerequisites

- **Bun** 1.0+: [Install Bun](https://bun.sh)
- **Node.js** 18+ (for some dependencies)
- **Python** 3.10+ (for BioDSBench/BioMniBench task execution)
- **LLM API access**: Anthropic API key or compatible endpoint

### Installation

```bash
git clone https://github.com/starpacker/biodsbench-adapter.git
cd biodsbench-adapter
bun install
```

### Configuration

1. **Set up API credentials**:
   ```bash
   export ANTHROPIC_API_KEY="your-api-key-here"
   export ANTHROPIC_BASE_URL="https://api.anthropic.com"  # or your proxy
   export ANTHROPIC_MODEL="[REDACTED]"
   ```

2. **Optional**: Copy `config/llm-config.sh.example` to `config/llm-config.sh` and customize.

### Run a Single Task

```bash
bun src/harness/evaluation/cli.ts \
  --task mri_grappa \
  --runs-dir output/runs \
  --max-rounds 5 \
  --timeout-seconds 2400
```

### Run BioDSBench Tasks

Point `--tasks-dir` to the [BioDSBench-imaging101-format](https://github.com/starpacker/BioDSBench-imaging101-format) dataset:

```bash
bun src/harness/evaluation/cli.ts \
  --task 25303977_0 \
  --tasks-dir /path/to/BioDSBench-imaging101-format/tasks \
  --runs-dir output/biodsbench_runs \
  --max-rounds 2
```

---

## True-Serial Mode (Advanced)

When multiple subtasks share a common context, use **true-serial mode** to pass prior results to subsequent tasks.

### Python Orchestrator Example

See `examples/run_imaging101_true_serial.py`:

```bash
export LLM_API_KEY="your-api-key"
python3 examples/run_imaging101_true_serial.py \
  --study-id 25303977 \
  --start 0 \
  --end 7 \
  --max-rounds 2
```

**What it does**:
- Each subtask receives a `--prior-context` JSON file with descriptions, code, and judge feedback from earlier subtasks.
- The LLM can learn from earlier mistakes and reuse successful patterns.

**Documentation**:
- `examples/ARCHITECTURE.md`: Serial vs. single-task design
- `examples/EFFECTIVENESS_REPORT.md`: Case study on PMID 25303977

---

## Project Structure

```
biodsbench-adapter/
├── src/harness/evaluation/      # Core evaluation CLI
│   ├── cli.ts                   # Main entry point
│   ├── sourceTaskLoop.ts        # Task orchestration
│   ├── sourceContextBuilder.ts  # Prompt + prior-context injection
│   └── types.ts                 # TypeScript interfaces
├── config/
│   ├── llm-config.sh.example    # API config template
│   └── task-batch-runner.json   # Batch runner config
├── scripts/
│   └── run-task-batches.ps1     # PowerShell batch orchestrator
├── examples/
│   ├── run_imaging101_true_serial.py  # True-serial orchestrator
│   ├── ARCHITECTURE.md                # Design docs
│   └── EFFECTIVENESS_REPORT.md        # Effectiveness study
└── tests/                       # Unit tests
```

---

## Data Requirements

- **BioDSBench tasks**: Clone [BioDSBench-imaging101-format](https://github.com/starpacker/BioDSBench-imaging101-format)
  ```bash
  git clone https://github.com/starpacker/BioDSBench-imaging101-format.git
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
| `--prior-context <path>` | Prior-subtask context JSON (true-serial) | (none) |

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
- [BioDSBench-imaging101-format](https://github.com/starpacker/BioDSBench-imaging101-format): Dataset with 118 tasks

---

## License

MIT License (see LICENSE file)

---

## Contributing

Contributions welcome! Fork, branch, and submit a PR.

---

## Support

[Open an issue](https://github.com/starpacker/biodsbench-adapter/issues) for questions or bug reports.
