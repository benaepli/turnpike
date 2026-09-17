import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { explore, exploreFailure, materializeConfig, measurementCheckingError } from "./runners.js";

test("explorer checking outcomes preserve the exit code and allow offline processing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spur-caller-status-"));
  try {
    for (const code of [0, 2, 4, 1, 3, null]) {
      const binary = path.join(dir, "spur");
      fs.writeFileSync(binary, `#!/usr/bin/env node\n${code === null ? 'process.kill(process.pid, "SIGTERM")' : `process.exit(${code})`};\n`, { mode: 0o755 });
      const result = await explore({
        binary, configPath: "unused", spec: "unused", outputDir: path.join(dir, "output"),
        wallSec: 1, rayonThreads: 1,
      });
      const usable = code === 0 || code === 2 || code === 4;
      assert.equal(result.exitCode, code);
      assert.equal(result.ok, usable);
      assert.equal(result.timedOut, false);
      assert.equal(exploreFailure(result) === null, usable);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("measurement configs keep checking enabled through the whole sample", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spur-measurement-config-"));
  try {
    const template = path.join(dir, "template.json");
    const output = path.join(dir, "config.json");
    fs.writeFileSync(template, JSON.stringify({ linearizability: { enabled: false, workers: 3, queue_bytes: 4096, stop_on_violation: true } }));
    materializeConfig(template, output, { checkAllRuns: true, extra: { stats: true } });
    const config = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.deepEqual(config.linearizability, { enabled: true, workers: 3, queue_bytes: 4096, stop_on_violation: false });
    assert.equal(config.stats, true);
    assert.notEqual(measurementCheckingError(dir), null);
    const manifest = path.join(dir, "checking.json");
    fs.writeFileSync(manifest, JSON.stringify({ config: config.linearizability, reusable: true }));
    assert.equal(measurementCheckingError(dir), null);
    for (const invalid of [
      { config: { enabled: false, stop_on_violation: false }, reusable: true },
      { config: { enabled: true, stop_on_violation: true }, reusable: true },
      { config: config.linearizability, reusable: false },
    ]) {
      fs.writeFileSync(manifest, JSON.stringify(invalid));
      assert.notEqual(measurementCheckingError(dir), null);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
