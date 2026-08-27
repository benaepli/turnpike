// Repo paths, derived from this module's own location so the loop runs from
// any checkout. This file lives at ROOT/research/orchestrator/{src,dist}/,
// three levels below the root in both the tsx and the compiled case, and the
// derivation does not depend on the working directory.
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** Superproject checkout (github.com/benaepli/jennLang). */
export const SUPER = ROOT;
/** Spur submodule checkout (github.com/benaepli/spur). */
export const SPUR = path.join(ROOT, "spur");
