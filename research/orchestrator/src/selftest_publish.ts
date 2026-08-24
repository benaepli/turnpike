// End-to-end validation of the publish pipeline with a scripted no-op
// hypothesis: real branch, real PR into research/vr-loop, real squash-merge.
// Run: npx tsx src/selftest_publish.ts
import { appendFileSync } from "node:fs";
import * as path from "node:path";
import { createBranch, checkout, SPUR, SUPER, currentBranch } from "./gitops.js";
import { mergeFlow } from "./loop.js";
import { ROOT } from "./runners.js";
import { Hypothesis } from "./schemas.js";

const h = Hypothesis.parse({
  id: "publish-selftest",
  kind: "add",
  title: "Publish-pipeline selftest (no-op observation append)",
  description: "Scripted no-op change used once to validate branch -> PR -> squash-merge mechanics of the loop. Appends one line to research/observations/OBSERVATIONS.md.",
  category: "tooling",
  expectedGain: 0,
  expectedCost: 0.1,
  rationale: "validates the publish pipeline before unattended operation",
  generalityArgument: "not a scheduler change at all",
  createdAtIso: new Date().toISOString(),
});

const branch = "hyp/000-publish-selftest";
console.log("branches:", currentBranch(SUPER), currentBranch(SPUR));
createBranch(SUPER, branch);
checkout(SUPER, branch);
appendFileSync(path.join(ROOT, "research/observations/OBSERVATIONS.md"), `\n(publish selftest ${new Date().toISOString()})\n`);
const outcome = mergeFlow(0, h, branch, { selftest: true }, true);
console.log("outcome:", JSON.stringify(outcome, null, 2));
if (!outcome.merged) {
  console.error("PUBLISH SELFTEST FAILED");
  process.exit(1);
}
console.log("PUBLISH SELFTEST PASSED — merged into research/vr-loop via PR:", outcome.prUrls.join(", "));
