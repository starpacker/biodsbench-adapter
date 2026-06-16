#!/usr/bin/env python3
"""
对比新版（true_serial）和旧版（legacy serial）的串行测评效果。

用法：
    python3 compare_serial_versions.py [--study-id 25303977]

输出：
    - 控制台对比表
    - JSON: SERIAL_VERSIONS_COMPARISON.json
    - Markdown: SERIAL_VERSIONS_COMPARISON.md
"""
import argparse
import json
from pathlib import Path
from typing import Dict, List, Optional


LEGACY_DIR = Path("/data/yjh/imaging101_serial_results")
TRUE_DIR = Path("/data/yjh/imaging101_true_serial_results")


def find_latest_run(base_dir: Path, study_id: str, prefix: str) -> Optional[Path]:
    """找到指定 study_id 的最新一次运行目录。"""
    pattern = f"{study_id}_{prefix}_*"
    candidates = sorted(base_dir.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


def load_state(run_dir: Path) -> Optional[Dict]:
    """读取 evaluation_state.json。"""
    state_file = run_dir / "evaluation_state.json"
    if not state_file.exists():
        return None
    with open(state_file) as f:
        return json.load(f)


def task_status_map(state: Dict) -> Dict[str, str]:
    """构建 {task_id: status} 映射。"""
    result = {}
    for t in state.get("tasks", []):
        result[t["task_id"]] = t["status"]
    return result


def task_rounds_map(state: Dict) -> Dict[str, int]:
    """构建 {task_id: rounds_attempted} 映射。"""
    result = {}
    for t in state.get("tasks", []):
        rounds = t.get("rounds", [])
        if rounds:
            result[t["task_id"]] = len(rounds)
        else:
            result[t["task_id"]] = 1  # true_serial 只跑一次（CLI 内部多 round）
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--study-id", default="25303977")
    args = parser.parse_args()

    study_id = args.study_id

    legacy_run = find_latest_run(LEGACY_DIR, study_id, "serial")
    true_run = find_latest_run(TRUE_DIR, study_id, "true_serial")

    if not legacy_run:
        print(f"❌ 未找到旧版结果: {LEGACY_DIR}/{study_id}_serial_*")
        return
    if not true_run:
        print(f"❌ 未找到新版结果: {TRUE_DIR}/{study_id}_true_serial_*")
        return

    legacy_state = load_state(legacy_run)
    true_state = load_state(true_run)

    if not legacy_state or not true_state:
        print("❌ 无法加载 evaluation_state.json")
        return

    legacy_status = task_status_map(legacy_state)
    true_status = task_status_map(true_state)
    legacy_rounds = task_rounds_map(legacy_state)

    # 所有出现过的 task_id（按数字排序）
    all_tasks = sorted(
        set(legacy_status.keys()) | set(true_status.keys()),
        key=lambda t: int(t.split("_")[1]),
    )

    # 统计
    legacy_passed = sum(1 for t in all_tasks if legacy_status.get(t) == "passed")
    true_passed = sum(1 for t in all_tasks if true_status.get(t) == "passed")
    total = len(all_tasks)

    # 分类：保持通过 / 保持失败 / 新版修复 / 新版退化
    kept_pass: List[str] = []
    kept_fail: List[str] = []
    fixed_by_true: List[str] = []
    broken_by_true: List[str] = []

    for tid in all_tasks:
        l = legacy_status.get(tid, "missing")
        t = true_status.get(tid, "missing")
        if l == "passed" and t == "passed":
            kept_pass.append(tid)
        elif l == "passed" and t != "passed":
            broken_by_true.append(tid)
        elif l != "passed" and t == "passed":
            fixed_by_true.append(tid)
        else:
            kept_fail.append(tid)

    # 控制台输出
    print(f"\n{'='*80}")
    print(f"串行测评新旧版对比 - PMID {study_id}")
    print(f"{'='*80}")
    print(f"旧版 run: {legacy_run.name}")
    print(f"新版 run: {true_run.name}")
    print()
    print(f"  旧版（legacy serial）: {legacy_passed}/{total} 通过")
    print(f"  新版（true serial）  : {true_passed}/{total} 通过")
    print(f"  净变化              : {'+' if true_passed >= legacy_passed else ''}{true_passed - legacy_passed}")
    print()
    print("按任务对比：")
    print(f"  {'task_id':<15} {'旧版':<10} {'新版':<10} {'变化':<10}")
    for tid in all_tasks:
        l = legacy_status.get(tid, "N/A")
        t = true_status.get(tid, "N/A")
        if l == t:
            change = "—"
        elif l != "passed" and t == "passed":
            change = "✅ 新版修复"
        elif l == "passed" and t != "passed":
            change = "❌ 新版退化"
        else:
            change = f"{l}→{t}"
        print(f"  {tid:<15} {l:<10} {t:<10} {change:<10}")
    print()
    print(f"  保持通过: {len(kept_pass)} 个 {kept_pass}")
    print(f"  新版修复: {len(fixed_by_true)} 个 {fixed_by_true}")
    print(f"  新版退化: {len(broken_by_true)} 个 {broken_by_true}")
    print(f"  保持失败: {len(kept_fail)} 个 {kept_fail}")
    print(f"{'='*80}")

    # 保存 JSON
    output = {
        "study_id": study_id,
        "legacy_run": str(legacy_run),
        "true_run": str(true_run),
        "legacy_passed": legacy_passed,
        "true_passed": true_passed,
        "total": total,
        "kept_pass": kept_pass,
        "fixed_by_true_serial": fixed_by_true,
        "broken_by_true_serial": broken_by_true,
        "kept_fail": kept_fail,
        "per_task": {
            tid: {
                "legacy": legacy_status.get(tid),
                "true_serial": true_status.get(tid),
                "legacy_rounds": legacy_rounds.get(tid),
            }
            for tid in all_tasks
        },
    }
    json_path = Path("/home/yjh/SERIAL_VERSIONS_COMPARISON.json")
    with open(json_path, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"\n✅ JSON 已保存: {json_path}")

    # 保存 Markdown
    md_lines = [
        f"# 串行测评新旧版对比 - PMID {study_id}",
        "",
        f"- **旧版 run**: `{legacy_run.name}`",
        f"- **新版 run**: `{true_run.name}`",
        "",
        "## 结果汇总",
        "",
        f"| 版本 | 通过 | 总数 | 通过率 |",
        f"|------|------|------|--------|",
        f"| 旧版（legacy serial）| {legacy_passed} | {total} | {legacy_passed/total*100:.1f}% |",
        f"| 新版（true serial） | {true_passed} | {total} | {true_passed/total*100:.1f}% |",
        f"| **净变化** | {'+' if true_passed >= legacy_passed else ''}{true_passed - legacy_passed} | | |",
        "",
        "## 按任务对比",
        "",
        "| Task ID | 旧版 | 新版 | 变化 |",
        "|---------|------|------|------|",
    ]
    for tid in all_tasks:
        l = legacy_status.get(tid, "N/A")
        t = true_status.get(tid, "N/A")
        if l == t:
            change = "—"
        elif l != "passed" and t == "passed":
            change = "✅ 新版修复"
        elif l == "passed" and t != "passed":
            change = "❌ 新版退化"
        else:
            change = f"{l}→{t}"
        md_lines.append(f"| `{tid}` | {l} | {t} | {change} |")
    md_lines.extend([
        "",
        "## 分类",
        "",
        f"- **保持通过** ({len(kept_pass)} 个): {', '.join(f'`{t}`' for t in kept_pass) or '无'}",
        f"- **新版修复** ({len(fixed_by_true)} 个): {', '.join(f'`{t}`' for t in fixed_by_true) or '无'}",
        f"- **新版退化** ({len(broken_by_true)} 个): {', '.join(f'`{t}`' for t in broken_by_true) or '无'}",
        f"- **保持失败** ({len(kept_fail)} 个): {', '.join(f'`{t}`' for t in kept_fail) or '无'}",
        "",
        "## 解读",
        "",
        "- **新版修复**：说明 prior context（前置任务代码 + judge feedback）真的帮到模型，",
        "  让模型能复用前置任务的列名/逻辑，或避开同样的错误。",
        "- **新版退化**：值得关注 —— 可能是 prior context 引入了过多上下文，反而干扰了模型；",
        "  或者前置任务的错误代码被模型当作正确示例复用了。",
        "- **保持失败**：说明这些任务的失败不是上下文/feedback 能解决的，是真实的模型代码错误。",
        "",
    ])
    md_path = Path("/home/yjh/SERIAL_VERSIONS_COMPARISON.md")
    with open(md_path, "w") as f:
        f.write("\n".join(md_lines))
    print(f"✅ Markdown 已保存: {md_path}")


if __name__ == "__main__":
    main()
