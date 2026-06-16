#!/usr/bin/env python3
"""
BioDSBench-imaging101-format 真正串行测评脚本
与旧版 run_imaging101_*_serial.py 的关键区别：

1. 真正传递 context：每个子任务通过 --prior-context prior_context.json
   把前面已完成子任务的 description、generated_code、judge_feedback 传给模型
2. 解决"发现 3"（外层 retry 丢 feedback）：用 --max-rounds 2，让 CLI 内部承接
   judge feedback（同一 LLM session），外层不再 retry
3. 每个子任务用独立 outputs 目录（避免共享 outputs 触发 judge.py 的 monkey-patch
   副作用差异）

适用场景：
- 同一 PMID 的多个子任务（如 25303977_0 ~ 25303977_7）
- 任务间有共同的数据格式、列名、分析模式，希望模型复用经验而非每次从头推
"""
import json
import os
import subprocess
import sys
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional

class TrueSerialEvaluator:
    def __init__(self, 
                 study_id: str = "25303977",
                 start_idx: int = 0,
                 end_idx: int = 7,
                 tasks_dir: str = "/home/yjh/BioDSBench-imaging101-format/tasks",
                 results_dir: str = "/data/yjh/imaging101_true_serial_results",
                 max_rounds: int = 2,
                 timeout_seconds: int = 1800):
        """
        初始化真正串行测评器
        
        Args:
            study_id: 母任务ID
            start_idx: 起始子任务索引
            end_idx: 结束子任务索引（包含）
            tasks_dir: 任务目录
            results_dir: 结果目录
            max_rounds: 每个子任务的 judge 轮次（CLI 内部承接 feedback）
            timeout_seconds: 单次 CLI 执行超时（秒）
        """
        self.study_id = study_id
        self.start_idx = start_idx
        self.end_idx = end_idx
        self.tasks_dir = Path(tasks_dir)
        self.results_dir = Path(results_dir)
        self.max_rounds = max_rounds
        self.timeout_seconds = timeout_seconds
        
        # 创建运行目录
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.run_dir = self.results_dir / f"{study_id}_true_serial_{timestamp}"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        
        # my_claude CLI 工作目录
        self.my_claude_dir = Path("/home/yjh/my_claude")
        
        # 测评状态（会被每个子任务的结果填充）
        self.state = {
            "study_id": study_id,
            "start_idx": start_idx,
            "end_idx": end_idx,
            "model": "claude-4.7-opus",
            "mode": "true_serial_with_prior_context",
            "max_rounds": max_rounds,
            "status": "not_started",
            "completed_tasks": 0,
            "passed_tasks": 0,
            "failed_tasks": 0,
            "tasks": [],
            "start_time": datetime.now().isoformat(),
            "end_time": None
        }
        self._save_state()
    
    def _save_state(self):
        """保存测评状态"""
        state_file = self.run_dir / "evaluation_state.json"
        with open(state_file, "w") as f:
            json.dump(self.state, f, indent=2, ensure_ascii=False)
    
    def run(self) -> Dict:
        """
        运行真正串行测评
        
        Returns:
            测评结果字典
        """
        print(f"\n{'='*80}")
        print(f"BioDSBench-Imaging101-Format 真正串行测评 (True Serial with Prior Context)")
        print(f"{'='*80}")
        print(f"母任务: {self.study_id}")
        print(f"子任务范围: {self.start_idx} ~ {self.end_idx}")
        print(f"模型: claude-4.7-opus")
        print(f"运行目录: {self.run_dir}")
        print(f"每子任务 judge 轮次: {self.max_rounds} (CLI 内部承接 feedback)")
        print(f"上下文传递: 通过 --prior-context prior_context.json")
        print(f"{'='*80}\n")
        
        self.state["status"] = "running"
        self._save_state()
        
        # 串行执行每个子任务
        for task_idx in range(self.start_idx, self.end_idx + 1):
            task_id = f"{self.study_id}_{task_idx}"
            
            print(f"\n{'='*80}")
            print(f"子任务 [{task_idx - self.start_idx + 1}/{self.end_idx - self.start_idx + 1}]: {task_id}")
            print(f"{'='*80}")
            
            # 执行子任务（只执行一次，失败也进入下一个）
            result = self._execute_task(task_id, task_idx)
            
            # 记录结果
            self.state["tasks"].append(result)
            self.state["completed_tasks"] += 1
            
            if result["status"] == "passed":
                self.state["passed_tasks"] += 1
                print(f"✅ {task_id} 通过")
            else:
                self.state["failed_tasks"] += 1
                print(f"❌ {task_id} 失败 (仍继续执行后续任务，失败信息会传给下个任务)")
            
            self._save_state()
        
        # 完成
        self.state["end_time"] = datetime.now().isoformat()
        if self.state["passed_tasks"] == (self.end_idx - self.start_idx + 1):
            self.state["status"] = "all_passed"
        elif self.state["passed_tasks"] > 0:
            self.state["status"] = "partial_passed"
        else:
            self.state["status"] = "all_failed"
        self._save_state()
        
        # 打印总结
        total_tasks = self.end_idx - self.start_idx + 1
        print(f"\n{'='*80}")
        print(f"真正串行测评完成!")
        print(f"{'='*80}")
        print(f"通过: {self.state['passed_tasks']}/{total_tasks}")
        print(f"失败: {self.state['failed_tasks']}/{total_tasks}")
        print(f"成功率: {self.state['passed_tasks']/total_tasks*100:.1f}%")
        print(f"结果目录: {self.run_dir}")
        print(f"{'='*80}\n")
        
        return self.state
    
    def _execute_task(self, task_id: str, task_idx: int) -> Dict:
        """
        执行单个子任务
        
        关键差异：
        - 只执行一次（不 retry）
        - 失败也返回结果（会被记入 prior_context 供下个任务参考）
        - 用 --max-rounds 2，让 CLI 内部承接 judge feedback
        
        Args:
            task_id: 子任务ID
            task_idx: 子任务索引
        
        Returns:
            子任务执行结果
        """
        task_dir = self.run_dir / f"task_{task_idx}"
        task_dir.mkdir(exist_ok=True)
        
        # 每个子任务有独立 outputs 目录（避免共享触发 judge.py 副作用）
        outputs_dir = task_dir / "outputs"
        outputs_dir.mkdir(exist_ok=True)
        
        result = {
            "task_id": task_id,
            "task_idx": task_idx,
            "status": "failed",
            "start_time": datetime.now().isoformat(),
            "end_time": None,
            "cli_status": None,
            "judge_status": None,
            "reward": 0,
            "cli_run_dir": None,
            "error": None,
            "judge_feedback": None,
        }
        
        try:
            # 1. 构建 prior_context.json
            print(f"  1. 构建 prior_context.json...")
            prior_context = self._build_prior_context(task_idx)
            prior_context_file = task_dir / "prior_context.json"
            with open(prior_context_file, "w") as f:
                json.dump(prior_context, f, indent=2, ensure_ascii=False)
            print(f"     - 前置子任务数: {len(prior_context.get('priorSubtasks', []))}")
            
            # 2. 调用 CLI（只执行一次，用 --max-rounds 2 让 CLI 内部重试）
            print(f"  2. 调用 CLI (--max-rounds {self.max_rounds})...")
            cli_result = self._run_cli(task_id, task_dir, prior_context_file, outputs_dir)
            
            result["cli_status"] = cli_result.get("status")
            result["judge_status"] = cli_result.get("judge_status")
            result["reward"] = cli_result.get("reward", 0)
            result["cli_run_dir"] = cli_result.get("run_dir")
            result["judge_feedback"] = cli_result.get("judge_feedback")
            
            if cli_result.get("success"):
                result["status"] = "passed"
                print(f"  ✅ 通过! (judge={cli_result.get('judge_status')}, reward={cli_result.get('reward')})")
                # 保存生成的代码
                self._save_generated_code(task_id, task_idx, task_dir, cli_result.get("run_dir"))
            else:
                result["error"] = cli_result.get("error", "CLI execution failed")
                result["status"] = "failed"
                print(f"  ❌ 失败: {result['error'][:200]}")
                # 即使失败，也尝试保存代码片段（下个任务能看到错误模式）
                self._save_generated_code(task_id, task_idx, task_dir, cli_result.get("run_dir"))
        
        except Exception as e:
            result["error"] = str(e)
            result["status"] = "failed"
            print(f"  ❌ 执行出错: {e}")
        
        result["end_time"] = datetime.now().isoformat()
        return result
    
    def _build_prior_context(self, current_idx: int) -> Dict:
        """
        构建前置子任务上下文（传给 CLI 的 --prior-context 文件）
        
        Args:
            current_idx: 当前子任务索引
        
        Returns:
            包含 priorSubtasks 数组的字典
        """
        prior_subtasks = []
        
        # 收集前面已完成的子任务
        if current_idx > self.start_idx:
            for prev_idx in range(self.start_idx, current_idx):
                prev_task_id = f"{self.study_id}_{prev_idx}"
                
                # 从 state["tasks"] 找对应结果
                prev_result = None
                for task in self.state["tasks"]:
                    if task["task_idx"] == prev_idx:
                        prev_result = task
                        break
                
                if not prev_result:
                    continue
                
                # 组装成 PriorSubtaskContext 格式
                prior_info = {
                    "taskId": prev_task_id,
                    "taskIdx": prev_idx,
                    "status": prev_result["status"],
                    "passed": prev_result["status"] == "passed",
                    "description": self._read_task_description(prev_task_id),
                    "generatedCode": self._read_generated_code(prev_idx),
                    "judgeFeedback": prev_result.get("judge_feedback"),
                    "notes": self._infer_notes(prev_result),
                }
                prior_subtasks.append(prior_info)
        
        return {"priorSubtasks": prior_subtasks}
    
    def _run_cli(self, task_id: str, task_dir: Path, prior_context_file: Path, outputs_dir: Path) -> Dict:
        """
        调用 CLI 执行任务
        
        关键参数：
        - --prior-context: 传递前置子任务上下文
        - --max-rounds 2: CLI 内部承接 judge feedback（解决"发现 3"）
        - 独立 outputs_dir: 避免共享 outputs 触发 judge.py 副作用
        
        Args:
            task_id: 任务ID
            task_dir: 当前任务目录
            prior_context_file: prior_context.json 路径
            outputs_dir: 此任务的独立 outputs 目录
        
        Returns:
            CLI 执行结果
        """
        # 环境变量（不再设置 BIODSBENCH_OUTPUTS_DIR，避免共享副作用）
        env = {
            **subprocess.os.environ.copy(),
            "ANTHROPIC_API_KEY": os.environ.get("LLM_API_KEY", ""),
            "ANTHROPIC_BASE_URL": "https://api.gpugeek.com",
            "ANTHROPIC_MODEL": "Vendor2/Claude-4.7-opus",
            "ANTHROPIC_SMALL_FAST_MODEL": "Vendor2/Claude-4.7-opus",
            "MODEL_NAME": "Vendor2/Claude-4.7-opus",
            "BASE_URL": "https://api.gpugeek.com",
            "AGENT_LOG_DIR": str(self.run_dir / "agent_logs")
        }
        
        # CLI 命令
        cmd = [
            "/home/yjh/.bun/bin/bun",
            "src/harness/evaluation/cli.ts",
            "--task", task_id,
            "--tasks-dir", str(self.tasks_dir.absolute()),
            "--runs-dir", str(task_dir.absolute()),
            "--max-rounds", str(self.max_rounds),  # CLI 内部承接 feedback
            "--timeout-seconds", str(self.timeout_seconds),
            "--temperature", "1",
            "--thinking", "disabled",
            "--agent-runtime", "source",
            "--prior-context", str(prior_context_file.absolute()),  # 真正串行的关键！
        ]
        
        try:
            print(f"  执行命令: bun cli.ts --task {task_id} --prior-context {prior_context_file.name} ...")
            
            result = subprocess.run(
                cmd,
                cwd=str(self.my_claude_dir),
                env=env,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds + 120
            )
            
            # 保存 CLI 输出
            log_file = task_dir / "cli_output.log"
            with open(log_file, "w") as f:
                f.write(f"Command: {' '.join(cmd)}\n")
                f.write(f"Exit code: {result.returncode}\n\n")
                f.write("=== STDOUT ===\n")
                f.write(result.stdout)
                f.write("\n\n=== STDERR ===\n")
                f.write(result.stderr)
            
            # 解析 stdout JSON
            cli_result = {
                "exit_code": result.returncode,
                "status": "unknown",
                "reward": 0,
                "judge_status": "unknown",
                "run_dir": None,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "judge_feedback": None,
            }
            
            try:
                stdout_data = json.loads(result.stdout.strip())
                cli_result["status"] = stdout_data.get("status", "unknown")
                cli_result["reward"] = stdout_data.get("reward", 0)
                cli_result["judge_status"] = stdout_data.get("last_judge_status", "unknown")
                cli_result["run_dir"] = stdout_data.get("run_dir")
                # 尝试提取 judge feedback（从 trajectory 或 stderr）
                cli_result["judge_feedback"] = self._extract_judge_feedback(stdout_data, result.stderr)
            except (json.JSONDecodeError, ValueError) as e:
                print(f"  ⚠️  无法解析 CLI stdout 为 JSON: {e}")
            
            # 成功条件
            cli_result["success"] = (
                result.returncode == 0
                and cli_result["status"] == "success"
                and cli_result["reward"] >= 1
                and cli_result["judge_status"] == "pass"
            )
            
            if not cli_result["success"]:
                error_parts = []
                if result.returncode != 0:
                    error_parts.append(f"exit_code={result.returncode}")
                if cli_result["status"] != "success":
                    error_parts.append(f"status={cli_result['status']}")
                if cli_result["judge_status"] != "pass":
                    error_parts.append(f"judge={cli_result['judge_status']}")
                if cli_result["reward"] < 1:
                    error_parts.append(f"reward={cli_result['reward']}")
                cli_result["error"] = "; ".join(error_parts) if error_parts else "Unknown failure"
            
            return cli_result
        
        except subprocess.TimeoutExpired:
            return {
                "success": False,
                "error": f"Timeout after {self.timeout_seconds + 120} seconds",
                "exit_code": -1,
                "status": "timeout",
                "reward": 0,
                "judge_status": "timeout",
                "judge_feedback": None,
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "exit_code": -1,
                "status": "error",
                "reward": 0,
                "judge_status": "error",
                "judge_feedback": None,
            }
    
    def _extract_judge_feedback(self, stdout_data: Dict, stderr: str) -> Optional[str]:
        """
        从 CLI 输出中提取 judge feedback（供下个任务参考）
        
        Args:
            stdout_data: 解析后的 stdout JSON
            stderr: stderr 文本
        
        Returns:
            judge feedback 字符串，或 None
        """
        # 尝试从 stdout_data 的 trajectory_path 读取（如果可用）
        # 或者简单返回 last_judge_status
        judge_status = stdout_data.get("last_judge_status", "unknown")
        reward = stdout_data.get("reward", 0)
        return f"judge_status={judge_status}, reward={reward}"
    
    def _save_generated_code(self, task_id: str, task_idx: int, task_dir: Path, cli_run_dir: Optional[str]):
        """
        保存生成的代码（供下个任务参考）
        
        Args:
            task_id: 任务ID
            task_idx: 任务索引
            task_dir: 任务目录
            cli_run_dir: CLI 输出的 run_dir 路径
        """
        if not cli_run_dir:
            print(f"  ⚠️  未找到 CLI run_dir，跳过代码保存")
            return
        
        cli_run_path = Path(cli_run_dir)
        if not cli_run_path.exists():
            print(f"  ⚠️  CLI run_dir 不存在: {cli_run_path}")
            return
        
        # 查找 outputs/case_*.py
        outputs_dir = cli_run_path / "outputs"
        if outputs_dir.exists():
            case_files = sorted(outputs_dir.glob("case_*.py"))
            if case_files:
                combined_code = ""
                for case_file in case_files:
                    with open(case_file) as f:
                        combined_code += f"# === {case_file.name} ===\n"
                        combined_code += f.read()
                        combined_code += "\n\n"
                
                target_file = task_dir / "generated_code.py"
                with open(target_file, "w") as f:
                    f.write(combined_code)
                print(f"  💾 保存生成的代码: {target_file} ({len(case_files)} 个 case)")
                return
        
        print(f"  ⚠️  未在 CLI run 目录找到 case_*.py")
    
    def _read_task_description(self, task_id: str) -> Optional[str]:
        """读取任务描述（README.md）"""
        readme_path = self.tasks_dir / task_id / "README.md"
        if readme_path.exists():
            try:
                with open(readme_path) as f:
                    content = f.read()
                    # 截断过长的 README（保留前 2000 字符）
                    if len(content) > 2000:
                        return content[:2000] + "\n... [truncated]"
                    return content
            except Exception:
                pass
        return None
    
    def _read_generated_code(self, task_idx: int) -> Optional[str]:
        """读取已生成的代码"""
        code_file = self.run_dir / f"task_{task_idx}" / "generated_code.py"
        if code_file.exists():
            try:
                with open(code_file) as f:
                    content = f.read()
                    # 截断过长的代码（保留前 8000 字符）
                    if len(content) > 8000:
                        return content[:8000] + "\n... [code truncated]"
                    return content
            except Exception:
                pass
        return None
    
    def _infer_notes(self, task_result: Dict) -> Optional[str]:
        """
        从任务结果中推断 notes（供下个任务参考）
        
        Args:
            task_result: 任务结果字典
        
        Returns:
            notes 字符串，或 None
        """
        notes_parts = []
        
        if task_result.get("status") == "passed":
            notes_parts.append("✅ This sub-task passed judge.")
        else:
            notes_parts.append("❌ This sub-task failed judge.")
        
        if task_result.get("judge_status"):
            notes_parts.append(f"Judge status: {task_result['judge_status']}")
        
        if task_result.get("reward") is not None:
            notes_parts.append(f"Reward: {task_result['reward']}")
        
        return " | ".join(notes_parts) if notes_parts else None


def main():
    """主函数"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="BioDSBench-imaging101 真正串行测评（传递 prior context，CLI 内部承接 feedback）"
    )
    parser.add_argument("--study-id", default="25303977", help="母任务ID")
    parser.add_argument("--start", type=int, default=0, help="起始子任务索引")
    parser.add_argument("--end", type=int, default=7, help="结束子任务索引")
    parser.add_argument("--max-rounds", type=int, default=2, help="每个任务的 judge 轮次（CLI 内部）")
    parser.add_argument("--timeout", type=int, default=1800, help="单次 CLI 执行超时（秒）")
    
    args = parser.parse_args()
    
    # 创建并运行测评器
    evaluator = TrueSerialEvaluator(
        study_id=args.study_id,
        start_idx=args.start,
        end_idx=args.end,
        max_rounds=args.max_rounds,
        timeout_seconds=args.timeout
    )
    
    result = evaluator.run()
    
    # 打印最终结果
    print(f"\n完整结果已保存到: {evaluator.run_dir / 'evaluation_state.json'}")
    
    # 返回退出码
    if result["status"] == "all_passed":
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
