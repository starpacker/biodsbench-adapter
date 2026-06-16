#!/usr/bin/env bash
# BioDSBench Adapter — One-shot bootstrap
# =======================================
#
# After cloning ``biodsbench-adapter`` this script will:
#   1. Verify ``bun`` and ``conda`` are present
#   2. ``bun install`` framework deps
#   3. Clone the BioDSBench dataset from Hugging Face (with LFS smudge)
#   4. ``conda env create -f environment.yml -n biodsbench``
#   5. ``python scripts/setup_task_venvs.py --shared-conda biodsbench``
#      → wires every task's ``.venv`` to the shared conda env
#
# Environment variables you may override:
#   HF_TOKEN          Personal token (anonymous works for public repos)
#   HF_ENDPOINT       Default https://huggingface.co; use
#                     https://hf-mirror.com from mainland China
#   DATASET_DIR       Where to clone dataset (default: ./biodsbench-data)
#   DATASET_REPO      HF dataset repo
#                     (default: starpacker52/BioDSBench-imaging101-format)
#   CONDA_ENV         Conda env name (default: biodsbench)
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DATASET_DIR="${DATASET_DIR:-$ROOT/biodsbench-data}"
DATASET_REPO="${DATASET_REPO:-starpacker52/BioDSBench-imaging101-format}"
CONDA_ENV="${CONDA_ENV:-biodsbench}"
HF_ENDPOINT="${HF_ENDPOINT:-https://huggingface.co}"

step() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m  ✓\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m  ✗\033[0m %s\n" "$*"; exit 1; }

step "1/5  Checking prerequisites"
command -v bun     >/dev/null || err "bun not installed — see https://bun.sh"
command -v conda   >/dev/null || err "conda not installed — see https://docs.conda.io"
command -v git     >/dev/null || err "git not installed"
command -v python3 >/dev/null || err "python3 not installed"
ok "bun=$(bun --version)  conda=$(conda --version | awk '{print $2}')  python3=$(python3 --version | awk '{print $2}')"

step "2/5  Installing JS deps with bun"
bun install --frozen-lockfile
ok "node_modules ready"

step "3/5  Installing Python deps (huggingface_hub for dataset)"
python3 -m pip install --quiet --user huggingface_hub
ok "huggingface_hub installed"

step "4/5  Cloning BioDSBench dataset"
if [[ -d "$DATASET_DIR/.git" ]]; then
    ok "Dataset already present at $DATASET_DIR"
else
    # Use full LFS smudge so .venv binaries materialize correctly
    git lfs install 2>/dev/null || true
    git clone "$HF_ENDPOINT/datasets/$DATASET_REPO" "$DATASET_DIR"
    ok "Cloned to $DATASET_DIR"
fi

step "5/5  Setting up shared conda env + task venvs"
if conda env list | awk '{print $1}' | grep -qx "$CONDA_ENV"; then
    ok "Conda env '$CONDA_ENV' already exists"
else
    conda env create -f "$ROOT/environment.yml" -n "$CONDA_ENV"
    ok "Created conda env '$CONDA_ENV'"
fi
python3 scripts/setup_task_venvs.py \
    --shared-conda "$CONDA_ENV" \
    --tasks-dir "$DATASET_DIR/tasks"
ok "All 118 tasks wired to '$CONDA_ENV'"

step "Bootstrap complete!"
cat <<EOF

Next steps:
  1. Configure LLM credentials:
       export ANTHROPIC_API_KEY=sk-...
       export ANTHROPIC_BASE_URL=https://api.anthropic.com   # optional
       export ANTHROPIC_MODEL="claude-opus-4"               # optional

  2. Run a single task:
       bun src/harness/evaluation/cli.ts \\
         --task 25303977_0 \\
         --tasks-dir $DATASET_DIR/tasks \\
         --runs-dir output/runs \\
         --max-rounds 2

  3. Verify task venvs (any time):
       python scripts/setup_task_venvs.py --check --tasks-dir $DATASET_DIR/tasks
EOF
