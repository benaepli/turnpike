import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
FAKE_SPUR = """#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv
config = json.loads(pathlib.Path(args[args.index('--config') + 1]).read_text())
assert config['linearizability'] == {'enabled': True, 'stop_on_violation': False}
output = pathlib.Path(args[args.index('--output-dir') + 1])
pathlib.Path(os.environ['BENCH_TEST_OUTPUT']).write_text(str(output))
code = int(os.environ['BENCH_TEST_EXIT'])
(output / 'checking.json').write_text(json.dumps({'config': config['linearizability'], 'reusable': True}))
(output / 'session.json').write_text(json.dumps({'runs_completed': 3, 'wall_ms': 200, 'writer_flush_ms': 100}))
(output / 'checks_summary.json').write_text(json.dumps({'histories': 3, 'passed': 3 if code == 0 else 2,
    'violated': int(code == 2), 'unknown': int(code == 4), 'unchecked': 0, 'execution_errors': 0, 'errors': []}))
sys.exit(code)
"""


class BenchmarkStatusTest(unittest.TestCase):
    def test_checking_outcomes_report_actual_throughput_and_preserve_pending_work(self):
        with tempfile.TemporaryDirectory(prefix="spur-bench-test-") as scratch:
            root = pathlib.Path(scratch)
            (root / "scripts").mkdir()
            shutil.copyfile(ROOT / "scripts/bench.sh", root / "scripts/bench.sh")
            binary = root / "spur/target/release/spur"
            binary.parent.mkdir(parents=True)
            binary.write_text(FAKE_SPUR)
            binary.chmod(0o755)
            cargo = root / "cargo"
            cargo.write_text("#!/bin/sh\nexit 0\n")
            cargo.chmod(0o755)
            recorded = root / "output-path"
            env = {**os.environ, "PATH": f"{root}:{os.environ['PATH']}", "BENCH_TEST_OUTPUT": str(recorded)}
            for code in (0, 2, 4, 1, 3):
                with self.subTest(code=code):
                    result = subprocess.run(["bash", str(root / "scripts/bench.sh"), "small"],
                                            env={**env, "BENCH_TEST_EXIT": str(code)},
                                            capture_output=True, text=True, timeout=10)
                    output = pathlib.Path(recorded.read_text())
                    try:
                        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
                        if code in (0, 2, 4):
                            self.assertIn("Runs:     3 completed", result.stdout)
                            self.assertIn("Runs/sec: 10.0", result.stdout)
                        else:
                            self.assertNotIn("Runs/sec:", result.stdout)
                        self.assertEqual(output.exists(), code != 0)
                    finally:
                        shutil.rmtree(output, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
