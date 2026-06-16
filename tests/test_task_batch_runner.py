from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "run-task-batches.ps1"
DEFAULT_CONFIG = ROOT / "config" / "task-batch-runner.json"


def run_script(config: dict) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as tmp:
        config_path = Path(tmp) / "task-batch-runner.json"
        config = {"loadLocalConfig": False, **config}
        config_path.write_text(json.dumps(config), encoding="utf-8")
        return subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(SCRIPT),
                "-ConfigPath",
                str(config_path),
                "-DryRun",
                "-PlanJson",
            ],
            cwd=ROOT,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )


class TaskBatchRunnerTests(unittest.TestCase):
    def test_dry_run_builds_pipeline_command_with_max_concurrency(self) -> None:
        result = run_script(
            {
                "tasks": ["a", "b", "c", "d", "e", "f", "g"],
                "batchSize": 3,
                "runsDir": "output/custom-runs",
                "maxRounds": 4,
                "timeoutSeconds": 99,
                "timestampPrefix": "unit",
            }
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)

        self.assertEqual(plan["tasks"], ["a", "b", "c", "d", "e", "f", "g"])
        self.assertEqual(plan["maxConcurrentTasks"], 3)
        self.assertIs(plan["continueOnFailure"], True)
        command = plan["command"]
        for task in ["a", "b", "c", "d", "e", "f", "g"]:
            self.assertIn(f"'--task' '{task}'", command)
        self.assertIn("'--concurrency' '3'", command)
        self.assertIn("'--runs-dir' 'output/custom-runs'", command)
        self.assertIn("'--max-rounds' '4'", command)
        self.assertIn("'--timeout-seconds' '99'", command)

    def test_rejects_empty_task_list(self) -> None:
        result = run_script({"tasks": [], "batchSize": 3})

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tasks", result.stderr.lower())

    def test_mri_example_config_runs_requested_tasks_in_one_batch(self) -> None:
        result = run_script(
            {
                "tasks": ["mri_sense", "mri_tv"],
                "batchSize": 3,
                "timestampPrefix": "mri_sense_tv_rerun",
            }
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(plan["tasks"], ["mri_sense", "mri_tv"])
        self.assertEqual(plan["maxConcurrentTasks"], 3)
        self.assertIn("'--task' 'mri_sense'", plan["command"])
        self.assertIn("'--task' 'mri_tv'", plan["command"])

    def test_default_config_is_valid_task_set(self) -> None:
        config = json.loads(DEFAULT_CONFIG.read_text(encoding="utf-8"))

        self.assertIsInstance(config.get("tasks"), list)
        self.assertGreater(len(config["tasks"]), 0)
        self.assertTrue(all(isinstance(task, str) and task.strip() for task in config["tasks"]))
        self.assertEqual(config.get("batchSize"), 3)
        self.assertIs(config.get("continueOnFailure", True), True)

    def test_default_config_dry_run_matches_configured_pipeline(self) -> None:
        config = json.loads(DEFAULT_CONFIG.read_text(encoding="utf-8"))
        tasks = config["tasks"]
        batch_size = config.get("batchSize", 3)

        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(SCRIPT),
                "-DryRun",
                "-PlanJson",
            ],
            cwd=ROOT,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(plan["tasks"], tasks)
        self.assertEqual(plan["maxConcurrentTasks"], batch_size)
        self.assertIs(plan["continueOnFailure"], True)
        self.assertIn(f"'--task' '{tasks[0]}'", plan["command"])
        self.assertIn(f"'--task' '{tasks[-1]}'", plan["command"])


if __name__ == "__main__":
    unittest.main()
