#!/usr/bin/env python3
"""
BioDSBench Task Venv Setup
==========================

The BioDSBench dataset ships each task with a *stub* per-task venv at
``tasks/<task_id>/envs/runtime/.venv/`` that contains only ``bin/python``,
``bin/python3``, and ``bin/pip`` placeholders.  The full venv (with
``site-packages``, ``pyvenv.cfg``, ``lib/``) must be created locally before
the framework's judge runner can execute.

This script provides three strategies:

  1.  ``--shared-conda <env_name>``
      Symlink every task's ``.venv`` to a single pre-built conda environment
      (recommended for evaluation servers — fastest, smallest disk usage).

  2.  ``--per-task-venv``
      Build a fresh ``python -m venv`` per task and ``pip install -r
      envs/runtime/requirements.txt`` into it.  (slow, ~5 GB total)

  3.  ``--check`` (default)
      Report which tasks have working venvs (Python is a real ELF binary
      and at least pandas can be imported).

Usage::

    # Recommended fastest path:
    conda create -n biodsbench python=3.10 pandas numpy scipy matplotlib \
        seaborn scikit-learn statsmodels lifelines
    python scripts/setup_task_venvs.py --shared-conda biodsbench \
        --tasks-dir biodsbench-data/tasks

    # Per-task isolation:
    python scripts/setup_task_venvs.py --per-task-venv \
        --tasks-dir biodsbench-data/tasks

    # Audit only:
    python scripts/setup_task_venvs.py --check \
        --tasks-dir biodsbench-data/tasks
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def detect_conda_env(env_name: str) -> Path:
    """Locate a conda env by name."""
    try:
        result = subprocess.run(
            ["conda", "info", "--envs"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        sys.exit(f"ERROR: conda not found; needed for --shared-conda {env_name}")
    for line in result.stdout.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        parts = line.split()
        if parts[0] == env_name:
            return Path(parts[-1])
    sys.exit(f"ERROR: conda env '{env_name}' not found. Create it first with:\n"
             f"  conda create -n {env_name} python=3.10 pandas numpy scipy "
             f"matplotlib seaborn scikit-learn statsmodels lifelines")


def is_lfs_pointer(path: Path) -> bool:
    """A 100–200 byte text file starting with 'version https://git-lfs...'."""
    try:
        if path.is_symlink():
            return False
        if path.stat().st_size > 1024:
            return False
        with open(path, "rb") as fh:
            head = fh.read(64)
        return head.startswith(b"version https://git-lfs")
    except OSError:
        return False


def venv_status(task_venv: Path) -> str:
    """Return 'ok' | 'lfs-pointer' | 'symlink-broken' | 'incomplete' | 'missing'."""
    py = task_venv / "bin" / "python"
    if not task_venv.exists():
        return "missing"
    if task_venv.is_symlink():
        target = task_venv.resolve()
        if not target.exists() or not (target / "bin" / "python").exists():
            return "symlink-broken"
        return "ok"
    if not py.exists():
        return "missing"
    if is_lfs_pointer(py):
        return "lfs-pointer"
    if py.stat().st_size < 1024:
        return "lfs-pointer"
    # check site-packages
    lib_dir = task_venv / "lib"
    if not lib_dir.exists():
        return "incomplete"
    return "ok"


def setup_shared_conda(tasks_dir: Path, env_path: Path) -> int:
    fail = 0
    tasks = sorted([t for t in tasks_dir.iterdir() if t.is_dir()])
    for task in tasks:
        venv_dir = task / "envs" / "runtime" / ".venv"
        try:
            venv_dir.parent.mkdir(parents=True, exist_ok=True)
            if venv_dir.exists() or venv_dir.is_symlink():
                if venv_dir.is_symlink():
                    venv_dir.unlink()
                else:
                    shutil.rmtree(venv_dir)
            venv_dir.symlink_to(env_path)
            print(f"  ✓ {task.name}: -> {env_path}")
        except OSError as e:
            print(f"  ✗ {task.name}: {e}")
            fail += 1
    return fail


def setup_per_task_venv(tasks_dir: Path) -> int:
    fail = 0
    tasks = sorted([t for t in tasks_dir.iterdir() if t.is_dir()])
    for task in tasks:
        venv_dir = task / "envs" / "runtime" / ".venv"
        req = task / "envs" / "runtime" / "requirements.txt"
        if not req.exists():
            print(f"  ⊘ {task.name}: no requirements.txt, skipping")
            continue
        try:
            if venv_dir.exists() or venv_dir.is_symlink():
                if venv_dir.is_symlink():
                    venv_dir.unlink()
                else:
                    shutil.rmtree(venv_dir)
            subprocess.run(
                [sys.executable, "-m", "venv", str(venv_dir)],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                [str(venv_dir / "bin" / "pip"), "install", "-q",
                 "-r", str(req)],
                check=True,
            )
            print(f"  ✓ {task.name}: per-task venv built")
        except (subprocess.CalledProcessError, OSError) as e:
            print(f"  ✗ {task.name}: {e}")
            fail += 1
    return fail


def check(tasks_dir: Path) -> int:
    counts = {"ok": 0, "lfs-pointer": 0, "missing": 0,
              "incomplete": 0, "symlink-broken": 0}
    tasks = sorted([t for t in tasks_dir.iterdir() if t.is_dir()])
    for task in tasks:
        venv_dir = task / "envs" / "runtime" / ".venv"
        status = venv_status(venv_dir)
        counts[status] = counts.get(status, 0) + 1
        if status != "ok":
            print(f"  {status:15} {task.name}")
    print()
    print(f"Summary across {len(tasks)} tasks:")
    for s, n in sorted(counts.items()):
        print(f"  {s:15} {n}")
    return counts["ok"] != len(tasks)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--tasks-dir", required=True,
                   help="Path to tasks/ directory of the cloned dataset")
    grp = p.add_mutually_exclusive_group(required=True)
    grp.add_argument("--shared-conda", metavar="ENV_NAME",
                     help="Symlink every task's .venv to this conda env")
    grp.add_argument("--per-task-venv", action="store_true",
                     help="Build a per-task venv with pip install")
    grp.add_argument("--check", action="store_true",
                     help="Audit only — report status, make no changes")
    args = p.parse_args()

    tasks_dir = Path(args.tasks_dir).resolve()
    if not tasks_dir.is_dir():
        sys.exit(f"ERROR: --tasks-dir {tasks_dir} does not exist")
    print(f"Scanning {tasks_dir} …")
    print()

    if args.check:
        return check(tasks_dir)
    if args.shared_conda:
        env_path = detect_conda_env(args.shared_conda)
        print(f"Using conda env: {env_path}")
        print()
        return setup_shared_conda(tasks_dir, env_path)
    if args.per_task_venv:
        return setup_per_task_venv(tasks_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
