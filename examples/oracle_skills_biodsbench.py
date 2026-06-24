#!/usr/bin/env python3
"""
Oracle Skill Ablation on BioDSBench tasks.

This script demonstrates how to apply the **Priority Greedy Ablation** pipeline
from `src/oracle-skills/` to BioDSBench tasks. It is a thin Python wrapper
around the TypeScript `bun src/oracle-skills/cli.ts` commands so the algorithm
core stays a single source of truth (TypeScript).

Workflow:
    1. Generate an oracle skill bundle from the task's `std_code/` reference
       implementation. Two modes are available:
         - `template`: deterministic; no LLM call. Use for fast smoke tests.
         - `query-engine`: LLM author distils std_code into 8-14 atomic
           operations with ablation priorities. Use for real research runs.
    2. Validate the bundle.
    3. Render a baseline variant (all ops enabled) and inspect it.
    4. Either run greedy priority ablation, or list `--dry-run` candidates.

Example:
    # Template (no LLM) — verify the pipeline works end-to-end
    python examples/oracle_skills_biodsbench.py \\
        --dataset /path/to/BioDSBench-imaging101-format \\
        --task 25303977_0 \\
        --out output/oracle-skills/25303977_0 \\
        --mode template

    # Real research run with LLM author
    export LLM_API_KEY=<your-key>
    python examples/oracle_skills_biodsbench.py \\
        --dataset /path/to/BioDSBench-imaging101-format \\
        --task 25303977_0 \\
        --out output/oracle-skills/25303977_0 \\
        --mode query-engine \\
        --max-operations 10

You can also drive the underlying CLI directly:

    bun src/oracle-skills/cli.ts generate \\
        --task 25303977_0 \\
        --tasks-dir /path/to/BioDSBench-imaging101-format/tasks \\
        --out output/oracle-skills/25303977_0 \\
        --mode template
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
BUN = shutil.which("bun") or "bun"


def run_cli(args: list[str], *, cwd: Path | None = None) -> dict:
    """Run `bun src/oracle-skills/cli.ts ...` and return parsed JSON output."""
    cmd = [BUN, "src/oracle-skills/cli.ts", *args]
    print(f">>> {' '.join(cmd)}", flush=True)
    result = subprocess.run(
        cmd,
        cwd=str(cwd or REPO_ROOT),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stdout)
        sys.stderr.write(result.stderr)
        raise SystemExit(
            f"oracle-skills CLI failed (exit {result.returncode}): {' '.join(args)}"
        )
    stdout = result.stdout.strip()
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        # Some commands print plain text (e.g. `prompt` returns paths only).
        return {"stdout": stdout}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Run oracle skill ablation on a BioDSBench task",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--dataset",
        type=Path,
        required=True,
        help="Path to BioDSBench-imaging101-format root (parent of `tasks/`)",
    )
    p.add_argument(
        "--task",
        required=True,
        help="Task id under `<dataset>/tasks/` (e.g. 25303977_0)",
    )
    p.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Output bundle directory",
    )
    p.add_argument(
        "--mode",
        choices=["template", "query-engine"],
        default="template",
        help="Generation mode (default: template; uses LLM author for query-engine)",
    )
    p.add_argument(
        "--max-operations",
        type=int,
        default=10,
        help="Upper bound on atomic operations (max 14)",
    )
    p.add_argument(
        "--max-turns",
        type=int,
        default=12,
        help="LLM author session max turns (query-engine mode only)",
    )
    p.add_argument(
        "--skill-name",
        default=None,
        help="Override the auto-generated skill name `oracle-<task>`",
    )
    p.add_argument(
        "--model-profile",
        default=None,
        help="Evaluation model profile (for query-engine mode)",
    )
    p.add_argument(
        "--ablate",
        action="store_true",
        help="After generating the bundle, run the priority-greedy ablation pipeline",
    )
    p.add_argument(
        "--ablate-out",
        type=Path,
        default=None,
        help="Output dir for ablation experiment (default: <out>-ablation)",
    )
    p.add_argument(
        "--dry-run-ablation",
        action="store_true",
        help="Skip evaluation; only list candidate variants and exit",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()

    tasks_dir = args.dataset / "tasks"
    if not (tasks_dir / args.task).is_dir():
        sys.stderr.write(
            f"Task {args.task!r} not found under {tasks_dir!r}\n"
        )
        return 2

    if args.mode == "query-engine" and not os.environ.get("LLM_API_KEY") and not os.environ.get("ANTHROPIC_API_KEY"):
        sys.stderr.write(
            "query-engine mode requires LLM_API_KEY or ANTHROPIC_API_KEY in env.\n"
        )
        return 2

    # ---------------------------------------------------------------- generate
    print(f"\n=== [1/3] Generate bundle (mode={args.mode}) ===", flush=True)
    gen_args = [
        "generate",
        "--task", args.task,
        "--tasks-dir", str(tasks_dir),
        "--out", str(args.out),
        "--mode", args.mode,
        "--max-operations", str(args.max_operations),
    ]
    if args.skill_name:
        gen_args += ["--skill-name", args.skill_name]
    if args.mode == "query-engine":
        gen_args += ["--max-turns", str(args.max_turns)]
        if args.model_profile:
            gen_args += ["--model-profile", args.model_profile]
    gen_result = run_cli(gen_args)
    print(json.dumps(gen_result, indent=2))

    # ---------------------------------------------------------------- validate
    print("\n=== [2/3] Validate bundle ===", flush=True)
    val_result = run_cli(["validate", "--bundle", str(args.out)])
    print(json.dumps(val_result, indent=2))
    if not val_result.get("ok"):
        sys.stderr.write("Bundle validation failed; aborting.\n")
        return 1

    # ---------------------------------------------------------------- ablate
    if args.ablate or args.dry_run_ablation:
        ablate_out = args.ablate_out or args.out.with_name(args.out.name + "-ablation")
        print(f"\n=== [3/3] Ablation (out={ablate_out}) ===", flush=True)
        cli_args = [
            "ablate",
            "--bundle", str(args.out),
            "--out", str(ablate_out),
        ]
        if args.dry_run_ablation:
            cli_args += ["--dry-run"]
        else:
            cli_args += ["--task", args.task, "--tasks-dir", str(tasks_dir)]
            if args.model_profile:
                cli_args += ["--model-profile", args.model_profile]
        ab_result = run_cli(cli_args)
        # The dry-run dumps the full variant list; condense it.
        if args.dry_run_ablation:
            variants = ab_result.get("variants", [])
            print(f"Candidate variants ({len(variants)}):")
            for v in variants:
                print(
                    f"  - {v['name']:<14} kind={v['kind']:<12} "
                    f"drop={v.get('drop_op') or v.get('drop_ops') or '-'}"
                )
        else:
            print(json.dumps(ab_result, indent=2)[:2000])
            print("... (truncated; see ablate-out for full results)")

    print("\nDone.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
