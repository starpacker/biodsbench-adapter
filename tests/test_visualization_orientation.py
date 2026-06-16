from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class VisualizationOrientationTests(unittest.TestCase):
    def test_comparison_uses_the_same_image_transform_for_agent_and_reference(self) -> None:
        runtime = load_module("visualization_runtime_under_test", ROOT / "tasks" / "_visualization_runtime.py")
        image = np.arange(6).reshape(2, 3)
        spec = {"origin": "lower", "extent": [80.0, -80.0, -80.0, 80.0]}

        np.testing.assert_array_equal(runtime.comparison_image(image, spec), image)

    def test_uq_task_does_not_force_agent_orientation_to_match_reference(self) -> None:
        visualization = load_module(
            "eht_black_hole_uq_visualization",
            ROOT / "tasks" / "eht_black_hole_UQ" / "evaluation" / "visualization.py",
        )

        output_spec = visualization.PLOT_STYLE["outputs"][0]
        comparison_spec = visualization.PLOT_STYLE["compare"][0]

        self.assertNotIn("transform", output_spec)
        self.assertNotIn("out_transform", comparison_spec)
        self.assertNotIn("ref_transform", comparison_spec)
        self.assertEqual(output_spec.get("origin"), comparison_spec.get("origin"))
        self.assertEqual(output_spec.get("extent"), comparison_spec.get("extent"))


if __name__ == "__main__":
    unittest.main()
