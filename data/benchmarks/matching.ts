import { PROVIDER_PRIORITY, type ModelCard } from "../../inference/types.js";

import type {
    BenchmarkModelLink,
    BenchmarkObservationRow,
    BenchmarkOperation,
    RawBenchmarkRecord,
} from "./types.js";

const POWER_TIERS = new Map<string, number>([
    ["minimal", 1],
    ["low", 2],
    ["medium", 3],
    ["high", 4],
    ["xhigh", 5],
    ["extra high", 5],
    ["maximum", 6],
    ["max effort", 6],
    ["maximum effort", 6],
    ["low effort", 2],
    ["medium effort", 3],
    ["high effort", 4],
    ["xhigh effort", 5],
    ["extra high effort", 5],
]);

/**
 * Artificial Analysis measurement-mode labels: variant dimensions of the
 * same model, never model identity or parameters. They must not leak into
 * baseName (which breaks identity matching) or parameters (which splits
 * power groups that should compete for one link). "Adaptive Reasoning" is
 * Anthropic's reasoning-mode toggle — AA records like "Claude Opus 5
 * (Adaptive Reasoning, Max Effort)" all describe the one canonical
 * `claude-opus-5` model. Keys are stored in normalized form (hyphens and
 * underscores folded to spaces, lowercased) to match isVariantLabel.
 */
const VARIANT_LABELS = new Set([
    "reasoning",
    "non reasoning",
    "thinking",
    "non thinking",
    "adaptive reasoning",
]);

const OPERATION_COMPATIBILITY: Record<BenchmarkOperation, Set<string>> = {
    chat: new Set(["chat", "vision-chat", "deep-research"]),
    "text-to-image": new Set(["text-to-image"]),
    // Editing-capable generators are declared as text-to-image in the catalog.
    "image-to-image": new Set(["image-to-image", "text-to-image"]),
    "text-to-video": new Set(["text-to-video"]),
    // Image-conditioned video generators are declared as text-to-video.
    "image-to-video": new Set(["image-to-video", "text-to-video"]),
    "text-to-speech": new Set(["text-to-speech"]),
    "speech-to-text": new Set(["speech-to-text", "realtime-transcription"]),
    "speech-to-speech": new Set(["speech-to-speech", "realtime-speech", "realtime-omni"]),
    "text-to-audio": new Set(["text-to-audio"]),
};

const FAMILY_ALIASES = new Map<string, string[]>([
    ["alibaba", ["alibaba", "qwen"]],
    ["blackforestlabs", ["blackforestlabs", "blackforest", "flux"]],
    ["bytedance", ["bytedance", "seed", "seedream", "seedance"]],
    ["deepgram", ["deepgram"]],
    ["elevenlabs", ["elevenlabs"]],
    ["google", ["google", "gemini", "deepmind", "googlegemini"]],
    ["kling", ["kling", "klingai", "kuaishou", "kuaishouklingai"]],
    ["meta", ["meta", "llama", "metallama"]],
    ["microsoft", ["microsoft", "azure", "phi"]],
    ["minimax", ["minimax"]],
    ["mistral", ["mistral", "mistralai"]],
    ["moonshot", ["moonshot", "kimi", "moonshotai"]],
    ["nvidia", ["nvidia", "nemotron"]],
    ["openai", ["openai"]],
    ["pixverse", ["pixverse"]],
    ["stabilityai", ["stabilityai", "stability", "stable"]],
    ["xai", ["xai", "grok", "spacexai"]],
    ["zai", ["zai", "zhipu", "zhipuai", "glm"]],
]);

export interface PowerVariantInfo {
    groupKey: string;
    baseName: string;
    powerRank: number;
    parameters: string[];
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

export function identityTokens(value: string): string[] {
    return value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[’']/g, "")
        .split(/[^a-z0-9]+/u)
        .filter(Boolean);
}

export function identityKey(value: string): string {
    return identityTokens(value).join(" ");
}

function collapsedKey(value: string): string {
    return identityTokens(value).join("");
}

function powerTier(value: string): number | null {
    const normalized = normalizeWhitespace(value.toLowerCase().replace(/[_-]+/g, " "));
    return POWER_TIERS.get(normalized) ?? null;
}

function isVariantLabel(value: string): boolean {
    return VARIANT_LABELS.has(normalizeWhitespace(value.toLowerCase().replace(/[_-]+/g, " ")));
}

export function analyzePowerVariant(record: Pick<RawBenchmarkRecord, "sourceName" | "sourceSlug" | "operation" | "variant">): PowerVariantInfo {
    const name = normalizeWhitespace(record.sourceName);
    let baseName = name;
    let powerRank = 0;
    let parameters: string[] = [];

    const parenthetical = name.match(/\(([^)]+)\)\s*$/u);
    if (parenthetical) {
        const parts = parenthetical[1]
            .split(/[,/|]+/u)
            .map((part) => normalizeWhitespace(part))
            .filter(Boolean);
        const tierRanks = parts.map(powerTier).filter((rank): rank is number => rank !== null);
        if (tierRanks.length > 0) {
            powerRank = Math.max(...tierRanks);
        }
        // Measurement-mode labels are neither parameters nor identity; the
        // parenthetical is always stripped from the model's base name so
        // "(Reasoning)" and "(Adaptive Reasoning, High Effort)" variants
        // match the same catalog model.
        parameters = parts.filter((part) => powerTier(part) === null && !isVariantLabel(part));
        baseName = normalizeWhitespace(name.slice(0, parenthetical.index));
    }

    let slugBase = record.sourceSlug ?? baseName;
    const slugParts = slugBase.split("-").filter(Boolean);
    const suffixRank = slugParts.length > 1 ? powerTier(slugParts[slugParts.length - 1]!) : null;
    if (suffixRank !== null) {
        powerRank = Math.max(powerRank, suffixRank);
        slugBase = slugParts.slice(0, -1).join("-");
    }

    const groupParts = [record.operation, record.variant ?? "", identityKey(baseName), parameters.map(identityKey).join(" ")];
    return {
        groupKey: groupParts.join("|"),
        baseName,
        powerRank,
        parameters,
    };
}

function primaryValue(record: RawBenchmarkRecord, metric: string): number | null {
    return record.metrics[metric] ?? null;
}

export function selectBestPowerVariants(
    records: RawBenchmarkRecord[],
    qualityMetric: string,
    qualityDirection: "higher" | "lower",
): Array<{ record: RawBenchmarkRecord; power: PowerVariantInfo; isBest: boolean }> {
    const analyzed = records.map((record) => ({
        record,
        power: analyzePowerVariant(record),
    }));
    const groups = new Map<string, typeof analyzed>();
    for (const item of analyzed) {
        groups.set(item.power.groupKey, [...(groups.get(item.power.groupKey) ?? []), item]);
    }

    const output: Array<{ record: RawBenchmarkRecord; power: PowerVariantInfo; isBest: boolean }> = [];
    for (const group of groups.values()) {
        const scored = group.filter((item) => primaryValue(item.record, qualityMetric) !== null);
        const winner = (scored.length > 0 ? scored : group).reduce((best, current) => {
            const bestValue = primaryValue(best.record, qualityMetric);
            const currentValue = primaryValue(current.record, qualityMetric);
            if (bestValue !== null && currentValue !== null && bestValue !== currentValue) {
                const currentWins = qualityDirection === "higher" ? currentValue > bestValue : currentValue < bestValue;
                return currentWins ? current : best;
            }
            if (current.power.powerRank !== best.power.powerRank) {
                return current.power.powerRank > best.power.powerRank ? current : best;
            }
            const currentDate = current.record.releaseDate ?? "";
            const bestDate = best.record.releaseDate ?? "";
            if (currentDate !== bestDate) return currentDate > bestDate ? current : best;
            return current.record.sourceName.localeCompare(best.record.sourceName) < 0 ? current : best;
        });
        for (const item of group) output.push({ ...item, isBest: item === winner });
    }
    return output;
}

function modelOperations(model: ModelCard): Set<string> {
    const operations = new Set<string>();
    for (const capability of model.semantics?.capabilities ?? []) {
        if (typeof capability.operation === "string") operations.add(capability.operation);
    }
    return operations;
}

function supportsOperation(model: ModelCard, operation: BenchmarkOperation): boolean {
    const supported = OPERATION_COMPATIBILITY[operation];
    for (const modelOperation of modelOperations(model)) {
        if (supported.has(modelOperation)) return true;
    }
    return false;
}

function familyKey(value: string | null | undefined): string {
    return value ? collapsedKey(value) : "";
}

function familiesCompatible(sourceCreator: string, model: ModelCard): boolean {
    const source = familyKey(sourceCreator);
    const family = familyKey(model.family || model.provider);
    if (!source || !family) return false;
    if (source === family || source.includes(family) || family.includes(source)) return true;
    const aliases = FAMILY_ALIASES.get(family) ?? [];
    return aliases.some((alias) => source === collapsedKey(alias) || source.includes(collapsedKey(alias)));
}

function aliasKeys(record: RawBenchmarkRecord): Array<{ value: string; key: string; method: BenchmarkModelLink["matchMethod"]; score: number }> {
    const power = analyzePowerVariant(record);
    const aliases: Array<{ value: string; method: BenchmarkModelLink["matchMethod"]; score: number }> = [];
    if (record.sourceSlug) aliases.push({ value: record.sourceSlug, method: "exact-id", score: 100 });
    aliases.push({ value: power.baseName, method: "exact-name", score: 82 });
    if (record.sourceName !== power.baseName) aliases.push({ value: record.sourceName, method: "exact-name", score: 76 });
    if (/^[a-z0-9][a-z0-9._/-]*$/i.test(record.sourceModelId)) {
        aliases.push({ value: record.sourceModelId, method: "exact-id", score: 70 });
    }
    return aliases
        .map((alias) => ({ ...alias, key: identityKey(alias.value) }))
        .filter((alias) => alias.key.length > 0) as Array<{ value: string; key: string; method: BenchmarkModelLink["matchMethod"]; score: number }>;
}

function candidateAliases(model: ModelCard): Array<{ key: string; method: BenchmarkModelLink["matchMethod"]; score: number }> {
    const aliases: Array<{ value: string; method: BenchmarkModelLink["matchMethod"]; score: number }> = [
        { value: model.modelId, method: "exact-id", score: 100 },
    ];
    if (model.upstreamModelId) aliases.push({ value: model.upstreamModelId, method: "exact-alias", score: 92 });
    // Multi-provider rows expose every serving provider's wire ID, so an
    // Artificial Analysis spelling matching any provider still links to the
    // one canonical row.
    for (const route of model.providerRoutes ?? []) {
        aliases.push({ value: route.upstreamModelId, method: "exact-alias", score: 92 });
    }
    if (model.name) aliases.push({ value: model.name, method: "exact-name", score: 82 });
    if (model.family) aliases.push({ value: `${model.family}/${model.modelId}`, method: "exact-alias", score: 88 });
    return aliases
        .map((alias) => ({ ...alias, key: identityKey(alias.value) }))
        .filter((alias) => alias.key.length > 0) as Array<{ key: string; method: BenchmarkModelLink["matchMethod"]; score: number }>;
}

export function matchBenchmarkRecord(
    record: RawBenchmarkRecord,
    catalog: ModelCard[],
    catalogVersion: string,
): BenchmarkModelLink {
    const sourceAliases = aliasKeys(record);
    const candidates: Array<{
        model: ModelCard;
        score: number;
        confidence: number;
        method: BenchmarkModelLink["matchMethod"];
    }> = [];

    for (const model of catalog) {
        if (model.available === false || !supportsOperation(model, record.operation)) continue;
        let best: { score: number; method: BenchmarkModelLink["matchMethod"] } | null = null;
        for (const sourceAlias of sourceAliases) {
            for (const candidateAlias of candidateAliases(model)) {
                if (sourceAlias.key !== candidateAlias.key) continue;
                const score = Math.max(sourceAlias.score, candidateAlias.score);
                if (!best || score > best.score) best = { score, method: candidateAlias.method };
            }
        }
        if (!best) continue;

        const familyCompatible = familiesCompatible(record.sourceCreatorSlug, model) || familiesCompatible(record.sourceCreatorName, model);
        const providerPriority = PROVIDER_PRIORITY[model.provider] ?? 99;
        candidates.push({
            model,
            score: best.score + (familyCompatible ? 30 : 0) - providerPriority / 100,
            confidence: Math.min(1, (best.score + (familyCompatible ? 18 : 0)) / 118),
            method: best.method,
        });
    }

    candidates.sort((left, right) =>
        right.score - left.score ||
        (PROVIDER_PRIORITY[left.model.provider] ?? 99) - (PROVIDER_PRIORITY[right.model.provider] ?? 99) ||
        left.model.modelId.localeCompare(right.model.modelId)
    );

    const winner = candidates[0];
    if (!winner) {
        return {
            operation: record.operation,
            sourceModelId: record.sourceModelId,
            catalogModelId: null,
            catalogProvider: null,
            matchMethod: "unmatched",
            matchConfidence: 0,
            reviewed: false,
            catalogVersion,
        };
    }

    return {
        operation: record.operation,
        sourceModelId: record.sourceModelId,
        catalogModelId: winner.model.modelId,
        catalogProvider: winner.model.provider,
        matchMethod: winner.method,
        matchConfidence: Number(winner.confidence.toFixed(3)),
        reviewed: false,
        catalogVersion,
    };
}

export function observationFromAnalysis(
    runId: string,
    item: { record: RawBenchmarkRecord; power: PowerVariantInfo; isBest: boolean },
): BenchmarkObservationRow {
    const parameterVariant = item.power.parameters
        .map((parameter) => normalizeWhitespace(parameter).toLowerCase())
        .filter(Boolean)
        .join(", ");
    const variant = [item.record.variant, parameterVariant]
        .filter((value): value is string => Boolean(value))
        .join(", ") || null;

    return {
        runId,
        sourceModelId: item.record.sourceModelId,
        operation: item.record.operation,
        variant,
        powerGroup: item.power.groupKey,
        isBestVariant: item.isBest,
        metrics: item.record.metrics,
        payload: {
            ...item.record.payload,
            _composePowerVariant: {
                baseName: item.power.baseName,
                rank: item.power.powerRank,
                parameters: item.power.parameters,
            },
        },
    };
}
