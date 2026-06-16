#!/usr/bin/env python3
"""
BioDSBench-imaging101-format 串行测评脚本
专门用于测评 25303977_0 ~ 25303977_7 任务，上下文可承接

模型: claude-4.7-opus
测评方式: 串行执行，上下文累积
"""
import json
import os
import subprocess
import sys
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional

class Imaging101SerialEvaluator:
    def __init__(self, 
                 study_id: str = "25303977",
                 start_idx: int = 0,
                 end_idx: int = 7,
                 tasks_dir: str = "/home/yjh/BioDSBench-imaging101-format/tasks",
                 results_dir: str = "/data/yjh/imaging101_serial_results",
                 max_rounds_per_task: int = 3,
                 timeout_seconds: int = 1800):
        """
        初始化串行测评器
        
        Args:
            study_id: 母任务ID，默认 "25303977"
            start_idx: 起始子任务索引，默认 0
            end_idx: 结束子任务索引（包含），默认 7
            tasks_dir: 任务目录
            results_dir: 结果目录
            max_rounds_per_task: 每个子任务最多重试次数
            timeout_seconds: 单次执行超时时间（秒）
        """
        self.study_id = study_id
        self.start_idx = start_idx
        self.end_idx = end_idx
        self.tasks_dir = Path(tasks_dir)
        self.results_dir = Path(results_dir)
        self.max_rounds_per_task = max_rounds_per_task
        self.timeout_seconds = timeout_seconds
        
        # 创建运行目录
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.run_dir = self.results_dir / f"{study_id}_serial_{timestamp}"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        
        # 共享输出目录（所有子任务的输出都放这里）
        self.outputs_dir = self.run_dir / "outputs"
        self.outputs_dir.mkdir(exist_ok=True)
        
        # 工作目录（用于 BioDSBench CLI 执行）
        self.my_claude_dir = Path("/home/yjh/my_claude")
        
        # 测评状态
        self.state = {
            "study_id": study_id,
            "start_idx": start_idx,
            "end_idx": end_idx,
            "model": "claude-4.7-opus",
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
        运行串行测评
        
        Returns:
            测评结果字典
        """
        print(f"\n{'='*80}")
        print(f"BioDSBench-Imaging101-Format 串行测评")
        print(f"{'='*80}")
        print(f"母任务: {self.study_id}")
        print(f"子任务范围: {self.start_idx} ~ {self.end_idx}")
        print(f"模型: claude-4.7-opus")
        print(f"运行目录: {self.run_dir}")
        print(f"每个子任务最多重试: {self.max_rounds_per_task} 次")
        print(f"{'='*80}\n")
        
        self.state["status"] = "running"
        self._save_state()
        
        # 串行执行每个子任务
        for task_idx in range(self.start_idx, self.end_idx + 1):
            task_id = f"{self.study_id}_{task_idx}"
            
            print(f"\n{'='*80}")
            print(f"子任务 [{task_idx - self.start_idx + 1}/{self.end_idx - self.start_idx + 1}]: {task_id}")
            print(f"{'='*80}")
            
            # 执行子任务
            result = self._execute_task(task_id, task_idx)
            
            # 记录结果
            self.state["tasks"].append(result)
            self.state["completed_tasks"] += 1
            
            if result["status"] == "passed":
                self.state["passed_tasks"] += 1
                print(f"✅ {task_id} 通过")
            else:
                self.state["failed_tasks"] += 1
                print(f"❌ {task_id} 失败")
                # 注意：这里不 fail-fast，继续执行后续任务
                # 如果你希望失败后停止，取消下面两行的注释
                # self._save_state()
                # break
            
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
        print(f"串行测评完成!")
        print(f"{'='*80}")
        print(f"通过: {self.state['passed_tasks']}/{total_tasks}")
        print(f"失败: {self.state['failed_tasks']}/{total_tasks}")
        print(f"成功率: {self.state['passed_tasks']/total_tasks*100:.1f}%")
        print(f"结果目录: {self.run_dir}")
        print(f"{'='*80}\n")
        
        return self.state
    
    def _execute_task(self, task_id: str, task_idx: int) -> Dict:
        """
        执行单个子任务，支持重试
        
        Args:
            task_id: 子任务ID，如 "25303977_0"
            task_idx: 子任务索引
        
        Returns:
            子任务执行结果
        """
        task_dir = self.run_dir / f"task_{task_idx}"
        task_dir.mkdir(exist_ok=True)
        
        result = {
            "task_id": task_id,
            "task_idx": task_idx,
            "status": "failed",
            "rounds": [],
            "start_time": datetime.now().isoformat(),
            "end_time": None
        }
        
        # 尝试最多 max_rounds_per_task 次
        for round_num in range(1, self.max_rounds_per_task + 1):
            print(f"\n  --- Round {round_num}/{self.max_rounds_per_task} ---")
            
            round_dir = task_dir / f"round_{round_num}"
            round_dir.mkdir(exist_ok=True)
            
            round_result = {
                "round": round_num,
                "status": "failed",
                "start_time": datetime.now().isoformat(),
                "end_time": None,
                "error": None,
                "cli_output": None
            }
            
            try:
                # 1. 构建上下文
                print(f"  1. 构建上下文...")
                context = self._build_context(task_idx, round_num, result)
                
                # 保存上下文信息
                context_file = round_dir / "context.json"
                with open(context_file, "w") as f:
                    json.dump(context, f, indent=2, ensure_ascii=False)
                
                # 2. 调用 BioDSBench CLI 执行
                print(f"  2. 调用 BioDSBench CLI...")
                cli_result = self._run_cli(task_id, round_dir)
                round_result["cli_status"] = cli_result.get("status")
                round_result["judge_status"] = cli_result.get("judge_status")
                round_result["reward"] = cli_result.get("reward", 0)
                round_result["cli_run_dir"] = cli_result.get("run_dir")
                
                # 3. 根据 CLI 返回结果判定
                if cli_result.get("success"):
                    round_result["status"] = "passed"
                    round_result["end_time"] = datetime.now().isoformat()
                    result["rounds"].append(round_result)
                    result["status"] = "passed"
                    result["end_time"] = datetime.now().isoformat()
                    
                    # 保存生成的代码以供后续任务参考
                    self._save_generated_code(task_id, task_idx, round_dir)
                    
                    print(f"  ✅ Round {round_num} 通过! (judge={cli_result.get('judge_status')}, reward={cli_result.get('reward')})")
                    return result
                else:
                    round_result["error"] = cli_result.get("error", "CLI execution failed")
                    round_result["end_time"] = datetime.now().isoformat()
                    result["rounds"].append(round_result)
                    print(f"  ❌ Round {round_num} 失败: {round_result['error'][:200]}")
            
            except Exception as e:
                round_result["error"] = str(e)
                round_result["end_time"] = datetime.now().isoformat()
                result["rounds"].append(round_result)
                print(f"  ❌ 执行出错: {e}")
        
        # 所有轮次都失败
        result["end_time"] = datetime.now().isoformat()
        return result
    
    def _build_context(self, current_idx: int, round_num: int, current_result: Dict) -> Dict:
        """
        构建上下文：包含前面已完成子任务的信息
        
        Args:
            current_idx: 当前子任务索引
            round_num: 当前轮次
            current_result: 当前子任务的结果
        
        Returns:
            上下文字典
        """
        context = {
            "current_idx": current_idx,
            "current_task_id": f"{self.study_id}_{current_idx}",
            "round_num": round_num,
            "previous_tasks": [],
            "retry_info": None,
            "available_outputs": []
        }
        
        # 1. 收集前面已完成的子任务信息
        if current_idx > self.start_idx:
            for prev_idx in range(self.start_idx, current_idx):
                prev_task_id = f"{self.study_id}_{prev_idx}"
                
                # 找到对应的任务结果
                prev_result = None
                for task in self.state["tasks"]:
                    if task["task_idx"] == prev_idx:
                        prev_result = task
                        break
                
                if prev_result:
                    prev_info = {
                        "task_id": prev_task_id,
                        "task_idx": prev_idx,
                        "status": prev_result["status"],
                        "description": self._read_task_description(prev_task_id),
                        "generated_code": self._read_generated_code(prev_idx),
                        "output_files": []
                    }
                    
                    # 列出输出文件
                    if self.outputs_dir.exists():
                        output_files = list(self.outputs_dir.glob("*"))
                        prev_info["output_files"] = [f.name for f in output_files if f.is_file()]
                        context["available_outputs"].extend(prev_info["output_files"])
                    
                    context["previous_tasks"].append(prev_info)
        
        # 2. 如果是重试，添加前一轮的信息
        if round_num > 1 and current_result["rounds"]:
            prev_round = current_result["rounds"][-1]
            context["retry_info"] = {
                "previous_round": round_num - 1,
                "error": prev_round.get("error"),
                "failed_code": self._read_failed_code(current_idx, round_num - 1)
            }
        
        return context
    
    def _run_cli(self, task_id: str, round_dir: Path) -> Dict:
        """
        调用 BioDSBench CLI 执行任务
        
        Args:
            task_id: 任务ID
            round_dir: 当前轮次目录
        
        Returns:
            CLI 执行结果，包含解析后的 status、reward、judge_status
        """
        # 环境变量
        env = {
            **subprocess.os.environ.copy(),
            "BIODSBENCH_OUTPUTS_DIR": str(self.outputs_dir.absolute()),
            "ANTHROPIC_API_KEY": os.environ.get("LLM_API_KEY", ""),
            # 注意：SDK 内部硬编码请求路径 `/v1/messages`，所以 base_url 不能带 `/v1`
            # 否则最终URL 会是 `https://api.gpugeek.com/v1/v1/messages` → 404
            "ANTHROPIC_BASE_URL": "https://api.gpugeek.com",
            "ANTHROPIC_MODEL": "Vendor2/Claude-4.7-opus",
            "ANTHROPIC_SMALL_FAST_MODEL": "Vendor2/Claude-4.7-opus",
            # my_claude CLI 在 source 模式下读取这些变量来决定使用的模型
            "MODEL_NAME": "Vendor2/Claude-4.7-opus",
            "BASE_URL": "https://api.gpugeek.com",
            "AGENT_LOG_DIR": str(self.run_dir / "agent_logs")
        }
        
        # 构建命令
        cmd = [
            "/home/yjh/.bun/bin/bun",
            "src/harness/evaluation/cli.ts",
            "--task", task_id,
            "--tasks-dir", str(self.tasks_dir.absolute()),
            "--runs-dir", str(round_dir.absolute()),
            "--max-rounds", "1",
            "--timeout-seconds", str(self.timeout_seconds),
            "--temperature", "1",
            "--thinking", "disabled",
            "--agent-runtime", "source"
        ]
        
        try:
            print(f"  执行命令: bun cli.ts --task {task_id} ...")
            
            # 执行命令
            result = subprocess.run(
                cmd,
                cwd=str(self.my_claude_dir),
                env=env,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds + 120  # 额外120秒缓冲（给 judge 留时间）
            )
            
            # 保存 CLI 输出
            log_file = round_dir / "cli_output.log"
            with open(log_file, "w") as f:
                f.write(f"Command: {' '.join(cmd)}\n")
                f.write(f"Exit code: {result.returncode}\n\n")
                f.write("=== STDOUT ===\n")
                f.write(result.stdout)
                f.write("\n\n=== STDERR ===\n")
                f.write(result.stderr)
            
            # 解析 CLI 的 stdout JSON
            cli_result = {
                "exit_code": result.returncode,
                "status": "unknown",
                "reward": 0,
                "judge_status": "unknown",
                "run_dir": None,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
            
            try:
                # CLI 输出的 stdout 是一个 JSON 对象
                stdout_data = json.loads(result.stdout.strip())
                cli_result["status"] = stdout_data.get("status", "unknown")
                cli_result["reward"] = stdout_data.get("reward", 0)
                cli_result["judge_status"] = stdout_data.get("last_judge_status", "unknown")
                cli_result["run_dir"] = stdout_data.get("run_dir")
            except (json.JSONDecodeError, ValueError) as e:
                print(f"  ⚠️  无法解析 CLI stdout 为 JSON: {e}")
            
            # 成功条件：exit_code=0 且 status=success 且 reward=1 且 judge_status=pass
            cli_result["success"] = (
                result.returncode == 0
                and cli_result["status"] == "success"
                and cli_result["reward"] >= 1
                and cli_result["judge_status"] == "pass"
            )
            
            if not cli_result["success"]:
                # 构造错误信息
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
                "judge_status": "timeout"
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "exit_code": -1,
                "status": "error",
                "reward": 0,
                "judge_status": "error"
            }
    
    def _validate_output(self, task_id: str) -> Dict:
        """
        验证输出：检查 BioDSBench CLI 的评测结果
        
        Args:
            task_id: 任务ID
        
        Returns:
            验证结果
        """
        # BioDSBench CLI 会在任务目录中创建评测结果文件
        # 查找最新的运行目录
        task_path = self.tasks_dir / task_id
        
        # 检查 evaluation 目录中的结果
        eval_dir = task_path / "evaluation"
        if eval_dir.exists():
            # 查找评测结果文件（可能是 result.json 或其他）
            result_files = list(eval_dir.glob("*.json"))
            if result_files:
                # 读取最新的结果文件
                latest_result = sorted(result_files, key=lambda x: x.stat().st_mtime, reverse=True)[0]
                try:
                    with open(latest_result) as f:
                        eval_result = json.load(f)
                        # 根据评测结果判断是否通过
                        if eval_result.get("passed") or eval_result.get("status") == "passed":
                            return {"passed": True}
                        else:
                            return {
                                "passed": False,
                                "error": eval_result.get("error", "Evaluation failed")
                            }
                except Exception as e:
                    return {
                        "passed": False,
                        "error": f"Failed to parse evaluation result: {e}"
                    }
        
        # 如果找不到评测结果，尝试查看 test_cases
        # 简单的启发式：如果生成了预期的输出文件，认为通过
        expected_outputs = ["substitution_ratios.png"]  # 根据具体任务调整
        
        all_present = all((self.outputs_dir / f).exists() for f in expected_outputs)
        if all_present:
            return {"passed": True}
        
        return {
            "passed": False,
            "error": "Evaluation result not found or test failed"
        }
    
    def _save_generated_code(self, task_id: str, task_idx: int, round_dir: Path):
        """保存生成的代码（用于后续任务的上下文承接）"""
        # CLI 实际把代码写到 run_dir/outputs/case_NNN.py
        # 查找最新的 CLI run_dir（格式：{task_id}_{timestamp}）
        cli_run_dirs = [d for d in round_dir.glob(f"{task_id}_*") if d.is_dir()]
        
        if not cli_run_dirs:
            print(f"  ⚠️  未找到 CLI run 目录")
            return
        
        cli_run_dir = sorted(cli_run_dirs, key=lambda x: x.stat().st_mtime, reverse=True)[0]
        
        # 查找 outputs/case_*.py 文件
        outputs_dir = cli_run_dir / "outputs"
        if outputs_dir.exists():
            case_files = sorted(outputs_dir.glob("case_*.py"))
            if case_files:
                # 合并所有 case 的代码（一般只有一个 case_000.py）
                combined_code = ""
                for case_file in case_files:
                    with open(case_file) as f:
                        combined_code += f"# === {case_file.name} ===\n"
                        combined_code += f.read()
                        combined_code += "\n\n"
                
                # 保存到任务目录下，供后续任务读取
                target_file = self.run_dir / f"task_{task_idx}" / "generated_code.py"
                with open(target_file, "w") as f:
                    f.write(combined_code)
                print(f"  💾 保存生成的代码: {target_file} ({len(case_files)} 个 case)")
                
                # 同时复制到共享 outputs 目录（用于上下文承接）
                shared_target = self.outputs_dir / f"task_{task_idx}_{task_id}_code.py"
                with open(shared_target, "w") as f:
                    f.write(combined_code)
                return
        
        # 也尝试 workspace/ 中的 plan 文件
        workspace_dir = cli_run_dir / "workspace"
        if workspace_dir.exists():
            plan_files = list(workspace_dir.glob("plans/*.md"))
            if plan_files:
                latest_plan = sorted(plan_files)[-1]
                # 保存 plan 也作为上下文
                plan_target = self.run_dir / f"task_{task_idx}" / "plan.md"
                with open(plan_target, "w") as f:
                    f.write(latest_plan.read_text())
                print(f"  💾 保存 plan: {plan_target}")
        
        print(f"  ⚠️  未在 CLI run 目录找到生成的 case_*.py 文件")
    
    def _read_task_description(self, task_id: str) -> Optional[str]:
        """读取任务描述"""
        task_json = self.tasks_dir / task_id / "task.json"
        if task_json.exists():
            try:
                with open(task_json) as f:
                    task_data = json.load(f)
                    return task_data.get("queries", "")
            except Exception:
                pass
        return None
    
    def _read_generated_code(self, task_idx: int) -> Optional[str]:
        """读取已生成的代码"""
        code_file = self.run_dir / f"task_{task_idx}" / "generated_code.py"
        if code_file.exists():
            with open(code_file) as f:
                return f.read()
        return None
    
    def _read_failed_code(self, task_idx: int, round_num: int) -> Optional[str]:
        """读取失败轮次的代码"""
        code_file = self.run_dir / f"task_{task_idx}" / f"round_{round_num}" / "generated_code.py"
        if code_file.exists():
            with open(code_file) as f:
                return f.read()
        return None


def main():
    """主函数"""
    import argparse
    
    parser = argparse.ArgumentParser(description="BioDSBench-imaging101 串行测评")
    parser.add_argument("--study-id", default="25303977", help="母任务ID")
    parser.add_argument("--start", type=int, default=0, help="起始子任务索引")
    parser.add_argument("--end", type=int, default=7, help="结束子任务索引")
    parser.add_argument("--max-rounds", type=int, default=3, help="每个任务最多重试次数")
    parser.add_argument("--timeout", type=int, default=1800, help="单次执行超时时间（秒）")
    
    args = parser.parse_args()
    
    # 创建并运行测评器
    evaluator = Imaging101SerialEvaluator(
        study_id=args.study_id,
        start_idx=args.start,
        end_idx=args.end,
        max_rounds_per_task=args.max_rounds,
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
