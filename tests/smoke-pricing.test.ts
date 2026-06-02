/**
 * Pricing-coverage smoke test.
 *
 * For every model card in api/inference/data/models.json:
 *   1. Classify the card's modality via getModelCapabilities()
 *   2. Build authoritative billing with synthetic usage + media metrics
 *      sized to match the modality.
 *
 * Reports:
 *   - Failure count grouped by raw pricing unit
 *   - Sample model id + first error per unit
 *   - Per-modality success / fail tallies
 *
 * Run:  npx tsx tests/smoke-pricing.ts   (from api/)
 *
 * Exits 1 if ANY card fails — so the suite catches drift between
 * models.json and telemetry.ts/metering.ts.
 */

import fs from "node:fs";
import path from "node:path";

import { buildAuthoritativeBilling } from "../inference/telemetry.js";
import { getModelCapabilities, type CanonicalModality } from "../inference/catalog/modalities/index.js";
import { resolveOptionalModelParamValues } from "../inference/params-handler.js";
import type { ModelCard } from "../inference/types.js";

const modelsPath = path.resolve(process.cwd(), "inference/data/models.json");
const data = JSON.parse(fs.readFileSync(modelsPath, "utf8")) as { models?: ModelCard[] } | ModelCard[];
const models: ModelCard[] = Array.isArray(data)
    ? data
    : (data.models ?? Object.values(data) as unknown as ModelCard[]);

console.log(`Smoke testing ${models.length} model cards…\n`);

interface Result {
    modelId: string;
    provider: string;
    modality: CanonicalModality | null;
    units: string[];
    ok: boolean;
    error?: string;
}

const results: Result[] = [];

const SYNTHETIC_USAGE: Record<CanonicalModality, unknown> = {
    text: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        billingMetrics: {
            input_text_tokens: 100,
            output_text_tokens: 50,
            input_audio_tokens: 50,
            output_audio_tokens: 0,
            input_image_tokens: 50,
            output_image_tokens: 50,
            input_video_tokens: 50,
            output_video_tokens: 50,
        },
    },
    image: {
        // Mirror what OpenAI's gpt-image / gpt-4o-* responses report:
        // header-keyed token breakdowns on top of the canonical totals.
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        billingMetrics: {
            input_text_tokens: 100,
            output_text_tokens: 0,
            input_image_tokens: 50,
            output_image_tokens: 50,
        },
    },
    video: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        billingMetrics: {
            input_text_tokens: 100,
            output_text_tokens: 0,
            input_video_tokens: 0,
            output_video_tokens: 50,
        },
    },
    audio: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        billingMetrics: {
            input_text_tokens: 50,
            output_text_tokens: 50,
            input_audio_tokens: 50,
            output_audio_tokens: 0,
        },
    },
    embedding: {
        promptTokens: 100,
        totalTokens: 100,
        billingMetrics: {
            input_text_tokens: 100,
        },
    },
    realtime: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        billingMetrics: {
            input_text_tokens: 50,
            output_text_tokens: 50,
            input_audio_tokens: 50,
            output_audio_tokens: 50,
        },
    },
};

const SYNTHETIC_MEDIA: Record<CanonicalModality, Record<string, unknown>> = {
    text: {
        request: 1, character: 100, second: 30, minute: 0.5, hour: 0.0083,
        audio_second: 30, audio_minute: 0.5, audio_hour: 0.0083,
        credits_audio_second: 30, transcription: 1, duration: 30,
        generation: 1, image: 1, output: 1, usage: 1,
        cost: 1,
    },
    image: {
        request: 1, generated_units: 1, megapixel: 1, processed_megapixel: 1,
        pixel: 1_000_000, processed_pixel: 1_000_000,
        image: 1, output: 1, step: 28, tile: 4,
        second: 30, duration: 30, compute_second: 30,
        cost: 1, generation: 1,
    },
    video: {
        request: 1, video: 1, second: 6, duration: 6, minute: 0.1,
        generated_seconds: 6, generated_minutes: 0.1, generation: 1,
        width: 1280, height: 720, megapixel: 1, processed_megapixel: 1,
        compute_second: 6,
        cost: 1,
    },
    audio: {
        request: 1, character: 100, second: 30, minute: 0.5, hour: 0.0083,
        audio_second: 30, audio_minute: 0.5, audio_hour: 0.0083,
        transcription: 1, generation: 1, voice: 1, infill_character: 100,
        one_time_fee: 1, duration: 30, voice_changer: 30,
        pay_as_you_go: 1, growth: 1,
        cost: 1,
    },
    embedding: { request: 1, page: 1, second: 30, duration: 30, compute_second: 30, cost: 1 },
    realtime: {
        request: 1, character: 100, second: 30, minute: 0.5, hour: 0.0083,
        audio_second: 30, audio_minute: 0.5, audio_hour: 0.0083,
        transcription: 1, generation: 1, duration: 30, output: 1,
        cost: 1,
    },
};

function deduceModality(card: ModelCard): CanonicalModality | null {
    const caps = getModelCapabilities(card);
    for (const m of ["video", "image", "audio", "embedding", "text", "realtime"] as CanonicalModality[]) {
        if (caps.some((c) => c.modality === m)) return m;
    }
    return null;
}

function pricingUnits(card: ModelCard): string[] {
    const out = new Set<string>();
    const visit = (obj: unknown): void => {
        if (!obj || typeof obj !== "object") return;
        const o = obj as Record<string, unknown>;
        if (typeof o.unit === "string") out.add(o.unit);
        for (const v of Object.values(o)) {
            if (v && typeof v === "object") visit(v);
            if (Array.isArray(v)) for (const i of v) if (i && typeof i === "object") visit(i);
        }
    };
    visit(card.pricing);
    return [...out];
}

let total = 0;
let failed = 0;

for (const card of models) {
    total++;
    const modality = deduceModality(card);
    const units = pricingUnits(card);
    const subject = `${card.provider}:${card.modelId}`;

    if (!modality) {
        results.push({ modelId: card.modelId, provider: card.provider, modality: null, units, ok: false, error: "no modality classified" });
        failed++;
        continue;
    }

    // Mirror what the gateway hands telemetry: the resolver-defaulted
    // param values (e.g. `quality: "standard"`, `n: 1`, `duration: 4`,
    // …) are folded into `billingMetrics` so tier-based pricing maps
    // cleanly. This makes the smoke test reflect a real live call.
    const paramDefaults =
        modality === "image" || modality === "video" || modality === "audio"
            ? resolveOptionalModelParamValues(card.modelId, modality === "video" ? "video" : modality === "image" ? "image" : undefined, {})?.values ?? {}
            : {};

    const mediaMetrics: Record<string, unknown> = {
        ...SYNTHETIC_MEDIA[modality],
        ...paramDefaults,
    };

    try {
        buildAuthoritativeBilling({
            subject,
            modality,
            pricing: card.pricing as never,
            usage: SYNTHETIC_USAGE[modality],
            media: { billingMetrics: mediaMetrics },
        });
        results.push({ modelId: card.modelId, provider: card.provider, modality, units, ok: true });
    } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ modelId: card.modelId, provider: card.provider, modality, units, ok: false, error: msg });
    }
}

console.log("=== TOTALS ===");
console.log(`  total: ${total}`);
console.log(`  ok:    ${total - failed}`);
console.log(`  fail:  ${failed}`);

console.log("\n=== FAILURES BY UNIT ===");
const byUnit = new Map<string, { count: number; sample: Result; allErrors: Set<string> }>();
for (const r of results) {
    if (r.ok) continue;
    for (const unit of r.units.length > 0 ? r.units : ["(none)"]) {
        const bucket = byUnit.get(unit) ?? { count: 0, sample: r, allErrors: new Set<string>() };
        bucket.count++;
        bucket.allErrors.add(r.error ?? "");
        byUnit.set(unit, bucket);
    }
}
for (const [unit, info] of [...byUnit.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(info.count).padStart(5)}  unit=${JSON.stringify(unit)}`);
    console.log(`         sample: ${info.sample.modelId} (${info.sample.provider}, ${info.sample.modality})`);
    for (const e of info.allErrors) console.log(`         error:  ${e}`);
}

console.log("\n=== FAILURES BY MODALITY ===");
const byModality = new Map<string, number>();
for (const r of results) {
    if (r.ok) continue;
    const k = String(r.modality);
    byModality.set(k, (byModality.get(k) ?? 0) + 1);
}
for (const [m, c] of [...byModality.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padStart(5)}  modality=${m}`);
}

console.log(`\n=== AMBIGUOUS PRICING ===`);
const ambiguous = results.filter((r) => !r.ok && r.error && /ambiguous|conflict|multiple matching/i.test(r.error));
if (ambiguous.length === 0) {
    console.log("  (none)");
} else {
    for (const r of ambiguous.slice(0, 20)) {
        console.log(`  ${r.modelId} (${r.provider}, ${r.modality}): ${r.error}`);
    }
}

if (failed > 0) {
    console.error(`\n❌ ${failed} models would fail in a live billing call.`);
    process.exit(1);
}
console.log("\n✅ All models have unambiguous pricing.");
