import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

function assertNonEmptyString(value: unknown, label: string, errors: string[]): void {
    if (typeof value !== "string" || value.trim().length === 0) {
        errors.push(label);
    }
}

function assertNonEmptyStringArray(value: unknown, label: string, errors: string[]): void {
    if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || item.trim().length === 0)) {
        errors.push(label);
    }
}

function isFiniteNumberOrNull(value: unknown): boolean {
    return value === null || (typeof value === "number" && Number.isFinite(value));
}

function assertStringRecord(
    value: unknown,
    label: string,
    requiredKeys: string[],
    errors: string[],
): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push(label);
        return;
    }

    const record = value as Record<string, unknown>;
    for (const key of requiredKeys) {
        assertNonEmptyString(record[key], `${label}.${key}`, errors);
    }
}

function summarizeErrorPaths(errors: string[]): string {
    const counts = new Map<string, number>();

    for (const error of errors) {
        const normalized = error.replace(/models\[\d+\]/g, "models[*]");
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }

    return [...counts.entries()]
        .sort((a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1];
            return a[0].localeCompare(b[0]);
        })
        .map(([field, count]) => count === 1 ? field : `${field} x${count}`)
        .join(", ");
}

export function assertStrictProviderCatalog(data: unknown, label: string): void {
    const errors: string[] = [];
    const root = data as Record<string, unknown>;

    if (!root || typeof root !== "object" || Array.isArray(root)) {
        throw new Error(`${label}: root must be an object`);
    }

    assertNonEmptyString(root.provider, "provider", errors);
    assertNonEmptyString(root.retrievedAtUtc, "retrievedAtUtc", errors);

    const sourceStages = root.sourceStages as Record<string, unknown> | undefined;
    if (!sourceStages || typeof sourceStages !== "object" || Array.isArray(sourceStages)) {
        errors.push("sourceStages");
    } else {
        assertStringRecord(sourceStages.discovery, "sourceStages.discovery", ["kind", "url", "coverage"], errors);
        assertStringRecord(sourceStages.pricing, "sourceStages.pricing", ["kind", "url", "coverage"], errors);
        assertStringRecord(sourceStages.modelPages, "sourceStages.modelPages", ["kind", "url", "coverage"], errors);
    }

    if (!Number.isInteger(root.totalModels) || (root.totalModels as number) < 0) {
        errors.push("totalModels");
    }

    if (!Array.isArray(root.models) || root.models.length === 0) {
        errors.push("models");
    } else {
        for (const [index, rawModel] of root.models.entries()) {
            const model = rawModel as Record<string, unknown>;
            const prefix = `models[${index}]`;

            if (!model || typeof model !== "object" || Array.isArray(model)) {
                errors.push(prefix);
                continue;
            }

            assertNonEmptyString(model.id, `${prefix}.id`, errors);
            assertNonEmptyString(model.modelId, `${prefix}.modelId`, errors);
            assertNonEmptyString(model.name, `${prefix}.name`, errors);
            assertNonEmptyString(model.description, `${prefix}.description`, errors);
            assertNonEmptyString(model.type, `${prefix}.type`, errors);
            assertNonEmptyString(model.task, `${prefix}.task`, errors);
            assertNonEmptyString(model.modality, `${prefix}.modality`, errors);

            const supportedDataTypes = model.supportedDataTypes as Record<string, unknown> | undefined;
            if (!supportedDataTypes || typeof supportedDataTypes !== "object" || Array.isArray(supportedDataTypes)) {
                errors.push(`${prefix}.supportedDataTypes`);
            } else {
                assertNonEmptyStringArray(supportedDataTypes.inputs, `${prefix}.supportedDataTypes.inputs`, errors);
                assertNonEmptyStringArray(supportedDataTypes.outputs, `${prefix}.supportedDataTypes.outputs`, errors);
            }

            const contextWindow = model.contextWindow as Record<string, unknown> | undefined;
            if (!contextWindow || typeof contextWindow !== "object" || Array.isArray(contextWindow)) {
                errors.push(`${prefix}.contextWindow`);
            } else {
                if (!isFiniteNumberOrNull(contextWindow.inputTokens)) errors.push(`${prefix}.contextWindow.inputTokens`);
                if (!isFiniteNumberOrNull(contextWindow.outputTokens)) errors.push(`${prefix}.contextWindow.outputTokens`);
            }

            const pricing = model.pricing as Record<string, unknown> | undefined;
            if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) {
                errors.push(`${prefix}.pricing`);
            } else {
                assertNonEmptyString(pricing.unit, `${prefix}.pricing.unit`, errors);
                const values = pricing.values as Record<string, unknown> | undefined;
                if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length === 0) {
                    errors.push(`${prefix}.pricing.values`);
                } else {
                    for (const [key, value] of Object.entries(values)) {
                        if (typeof value !== "number" || !Number.isFinite(value)) {
                            errors.push(`${prefix}.pricing.values.${key}`);
                        }
                    }
                }
            }

            assertStringRecord(model.sources, `${prefix}.sources`, ["discovery", "pricing", "modelPage", "matchType"], errors);
        }
    }

    if (errors.length > 0) {
        throw new Error(`${label}: ${summarizeErrorPaths(errors)}`);
    }
}

export function assertProviderCatalogContainer(data: unknown, label: string): void {
    const errors: string[] = [];
    const root = data as Record<string, unknown>;

    if (!root || typeof root !== "object" || Array.isArray(root)) {
        throw new Error(`${label}: root must be an object`);
    }

    assertNonEmptyString(root.provider, "provider", errors);

    if (root.retrievedAtUtc !== undefined) {
        assertNonEmptyString(root.retrievedAtUtc, "retrievedAtUtc", errors);
    }

    if (root.totalModels !== undefined && (!Number.isInteger(root.totalModels) || (root.totalModels as number) < 0)) {
        errors.push("totalModels");
    }

    if (!Array.isArray(root.models)) {
        errors.push("models");
    }

    if (errors.length > 0) {
        throw new Error(`${label}: ${summarizeErrorPaths(errors)}`);
    }
}

export function findProviderScriptAuditViolations(source: string): string[] {
    const violations: string[] = [];

    if (/\|\|\s*""|\?\?\s*""/.test(source)) {
        violations.push("blank-string-fallback");
    }
    if (/\|\|\s*null|\?\?\s*null/.test(source)) {
        violations.push("null-fallback");
    }
    if (/\.includes\([^)]*\)\s*\|\|\s*[^;\n]*\.includes\(/.test(source)) {
        violations.push("fuzzy-includes-match");
    }
    if (/split\(["']\/["']\)\.pop\(\)/.test(source)) {
        violations.push("short-id-pop-match");
    }
    if (/lastUpdated\s*:/.test(source)) {
        violations.push("legacy-lastUpdated-root");
    }
    if (/modelsWithPricing\s*:/.test(source)) {
        violations.push("legacy-modelsWithPricing-root");
    }

    return violations;
}

export interface ProviderAuditFailure {
    target: string;
    details: string;
    kind: "script" | "catalog";
}

export function auditProviderScriptsAndCatalogs(scriptsDir: string, catalogsDir: string): ProviderAuditFailure[] {
    const failures: ProviderAuditFailure[] = [];

    for (const entry of fs.readdirSync(scriptsDir).filter(name => name.startsWith("sync-") && name.endsWith(".ts"))) {
        const filePath = path.join(scriptsDir, entry);
        const source = fs.readFileSync(filePath, "utf-8");
        const violations = findProviderScriptAuditViolations(source);
        if (violations.length > 0) {
            failures.push({
                target: filePath,
                details: violations.join(", "),
                kind: "script",
            });
        }
    }

    for (const entry of fs.readdirSync(catalogsDir).filter(name => name.endsWith(".json") && name !== "router.json")) {
        const filePath = path.join(catalogsDir, entry);
        try {
            const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            assertProviderCatalogContainer(raw, entry);
        } catch (error: any) {
            failures.push({
                target: filePath,
                details: error.message,
                kind: "catalog",
            });
        }
    }

    return failures;
}

test("findProviderScriptAuditViolations flags fuzzy model matching heuristics", () => {
    const source = `
function matchPricing(modelId, pricingMap) {
  for (const [key, value] of pricingMap) {
    if (key.includes(modelId) || modelId.includes(key)) return value;
    const shortId = modelId.split("/").pop() || "";
    if (shortId && key.includes(shortId)) return value;
  }
  return null;
}

const description = title || "";
const totalModels = items.length ?? null;
const output = { lastUpdated: new Date().toISOString(), modelsWithPricing: 1 };
`;

    const violations = findProviderScriptAuditViolations(source);

    assert.deepEqual(violations, [
        "blank-string-fallback",
        "null-fallback",
        "fuzzy-includes-match",
        "short-id-pop-match",
        "legacy-lastUpdated-root",
        "legacy-modelsWithPricing-root",
    ]);
});

test("assertStrictProviderCatalog rejects missing canonical fields", () => {
    assert.throws(
        () => assertStrictProviderCatalog({
            provider: "ovhcloud",
            retrievedAtUtc: "2026-03-06T00:00:00.000Z",
            totalModels: 1,
            sourceStages: {
                discovery: { kind: "api", url: "https://example.com/models", coverage: "all_models" },
                pricing: { kind: "pricing_table", url: "https://example.com/pricing", coverage: "provider_pricing" },
                modelPages: { kind: "model_pages", url: "https://example.com/models/{id}", coverage: "all_models" },
            },
            models: [
                {
                    id: "qwen3-coder-30b-a3b-instruct",
                    modelId: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
                    name: "Qwen3 Coder 30B",
                    description: "",
                    type: "text-generation",
                    task: "conversational",
                    modality: "text",
                    supportedDataTypes: { inputs: ["text"], outputs: [] },
                    contextWindow: { inputTokens: 131072, outputTokens: 131072 },
                    pricing: { unit: "per_1M_tokens_usd", values: { input: 0.07, output: 0.26 } },
                    sources: {
                        discovery: "https://example.com/models/qwen3",
                        pricing: "https://example.com/pricing#qwen3",
                        modelPage: "https://example.com/models/qwen3",
                        matchType: "exact",
                    },
                },
            ],
        }, "ovhcloud.json"),
        /description|supportedDataTypes\.outputs/i,
    );
});

test("assertStrictProviderCatalog accepts a complete canonical provider catalog", () => {
    const catalog = {
        provider: "wavespeed",
        retrievedAtUtc: "2026-03-06T00:00:00.000Z",
        totalModels: 1,
        sourceStages: {
            discovery: { kind: "api", url: "https://router.huggingface.co/v1/models", coverage: "all_models" },
            pricing: { kind: "pricing_table", url: "https://wavespeed.ai/pricing", coverage: "provider_pricing" },
            modelPages: { kind: "model_pages", url: "https://wavespeed.ai/models/{providerModelId}", coverage: "all_models" },
        },
        models: [
            {
                id: "wavespeed-ai/qwen-image/edit-plus-lora",
                modelId: "Qwen/Qwen-Image-Edit-2509",
                name: "Qwen Image Edit Plus (2509)",
                description: "Official provider page description.",
                type: "image-editing",
                task: "image-to-image",
                modality: "image",
                supportedDataTypes: { inputs: ["image", "text"], outputs: ["image"] },
                contextWindow: { inputTokens: null, outputTokens: null },
                pricing: { unit: "per_image_usd", values: { input: 0.025 } },
                sources: {
                    discovery: "https://router.huggingface.co/v1/models",
                    pricing: "https://wavespeed.ai/pricing",
                    modelPage: "https://wavespeed.ai/models/wavespeed-ai/qwen-image/edit-plus-lora",
                    matchType: "exact",
                },
            },
        ],
    };

    assert.doesNotThrow(() => assertStrictProviderCatalog(catalog, "wavespeed.json"));
});

test("assertStrictProviderCatalog compresses repeated missing-field failures", () => {
    assert.throws(
        () => assertStrictProviderCatalog({
            provider: "demo",
            retrievedAtUtc: "2026-03-06T00:00:00.000Z",
            totalModels: 2,
            sourceStages: {
                discovery: { kind: "api", url: "https://example.com/models", coverage: "all_models" },
                pricing: { kind: "pricing_table", url: "https://example.com/pricing", coverage: "provider_pricing" },
                modelPages: { kind: "model_pages", url: "https://example.com/models/{id}", coverage: "all_models" },
            },
            models: [
                {
                    id: "a",
                    modelId: "org/a",
                    name: "A",
                    description: "desc",
                    type: "text-generation",
                    task: "chat-completion",
                    modality: "text",
                    supportedDataTypes: { inputs: ["text"], outputs: ["text"] },
                    contextWindow: { inputTokens: null, outputTokens: null },
                    pricing: { unit: "per_1M_tokens_usd", values: {} },
                    sources: {
                        discovery: "https://example.com/models/a",
                        pricing: "https://example.com/pricing#a",
                        modelPage: "https://example.com/models/a",
                        matchType: "exact",
                    },
                },
                {
                    id: "b",
                    modelId: "org/b",
                    name: "B",
                    description: "desc",
                    type: "text-generation",
                    task: "chat-completion",
                    modality: "text",
                    supportedDataTypes: { inputs: ["text"], outputs: ["text"] },
                    contextWindow: { inputTokens: null, outputTokens: null },
                    pricing: { unit: "per_1M_tokens_usd", values: {} },
                    sources: {
                        discovery: "https://example.com/models/b",
                        pricing: "https://example.com/pricing#b",
                        modelPage: "https://example.com/models/b",
                        matchType: "exact",
                    },
                },
            ],
        }, "demo.json"),
        /models\[\*\]\.pricing\.values x2/i,
    );
});

test("assertProviderCatalogContainer accepts partial provider shards", () => {
    const partialCatalog = {
        provider: "publicai",
        retrievedAtUtc: "2026-03-07T00:00:00.000Z",
        totalModels: 2,
        models: [
            {
                id: "allenai/Molmo2-8B",
                modelId: "allenai/Molmo2-8B",
                pricing: null,
            },
            {
                id: "utter-project/EuroLLM-22B-Instruct-2512",
                modelId: "utter-project/EuroLLM-22B-Instruct-2512",
                pricing: {
                    unit: "usd_per_1m_tokens",
                    values: { input: 0.1, output: 0.2 },
                },
            },
        ],
    };

    assert.doesNotThrow(() => assertProviderCatalogContainer(partialCatalog, "publicai.json"));
});

test("assertProviderCatalogContainer accepts empty provider shards for fail-closed sync runs", () => {
    const emptyCatalog = {
        provider: "nscale",
        retrievedAtUtc: "2026-04-06T00:00:00.000Z",
        totalModels: 0,
        models: [],
    };

    assert.doesNotThrow(() => assertProviderCatalogContainer(emptyCatalog, "nscale.json"));
});
