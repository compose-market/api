import * as path from "path";
import { fileURLToPath } from "url";

import { auditProviderScriptsAndCatalogs } from "./hf-provider-audit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const scriptsDir = path.join(__dirname, "..", "shared", "inference", "scripts", "hf-providers");
const catalogsDir = path.join(__dirname, "..", "shared", "inference", "data", "providers", "huggingface");

const failures = auditProviderScriptsAndCatalogs(scriptsDir, catalogsDir);

if (failures.length === 0) {
    console.log("[audit-hf-providers] PASS: no script heuristics or catalog contract violations found");
    process.exit(0);
}

console.error(`[audit-hf-providers] FAIL: ${failures.length} violation(s) found`);
for (const failure of failures) {
    console.error(`  [${failure.kind}] ${failure.target}`);
    console.error(`    ${failure.details}`);
}

process.exit(1);
