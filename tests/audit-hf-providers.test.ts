import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditProviderScriptsAndCatalogs } from "./hf-provider-audit.test.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const scriptsDir = path.join(__dirname, "..", "shared", "inference", "scripts", "hf-providers");
const catalogsDir = path.join(__dirname, "..", "shared", "inference", "data", "providers", "huggingface");

test("HF provider scripts and catalogs satisfy audit constraints", { skip: !fs.existsSync(scriptsDir) || !fs.existsSync(catalogsDir) }, () => {
    const failures = auditProviderScriptsAndCatalogs(scriptsDir, catalogsDir);
    assert.deepEqual(failures, []);
});
