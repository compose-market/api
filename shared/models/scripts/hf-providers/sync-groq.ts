/**
 * Groq Pricing Sync
 * 
 * Hardcoded pricing from groq.com/pricing page
 * 
 * Output: groq.json with model→pricing mapping
 * 
 * Run: npx tsx scripts/sync-groq.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROVIDER = "groq";

// Groq pricing from their public pricing page
// Last updated: 2025-12-31
// Source: https://groq.com/pricing/
const GROQ_PRICING: Record<string, { input: number; output: number; type: string }> = {
    // LLMs - per 1M tokens
    "openai/gpt-oss-20b": { input: 0.00, output: 0.00, type: "llm" }, // Free preview
    "openai/gpt-oss-120b": { input: 0.00, output: 0.00, type: "llm" }, // Free preview
    "moonshotai/kimi-k2-instruct": { input: 0.20, output: 0.40, type: "llm" },
    "meta-llama/llama-4-scout-17b-16e-instruct": { input: 0.11, output: 0.34, type: "llm" },
    "meta-llama/llama-4-maverick-17b-128e-instruct": { input: 0.20, output: 0.60, type: "llm" },
    "meta-llama/llama-guard-4-12b": { input: 0.20, output: 0.20, type: "llm" },
    "qwen/qwen3-32b": { input: 0.10, output: 0.18, type: "llm" },
    "meta-llama/Llama-3.3-70B-Instruct": { input: 0.59, output: 0.79, type: "llm" },
    "meta-llama/Llama-3.1-8B-Instruct": { input: 0.05, output: 0.08, type: "llm" },

    // TTS - per 1M characters
    "playai/playai-dialog-v1.0": { input: 50.00, output: 0, type: "tts" },
    "canopylabs/orpheus-v1-english": { input: 15.00, output: 0, type: "tts" },

    // ASR - per hour
    "openai/whisper-large-v3": { input: 0.111, output: 0, type: "asr" },
    "openai/whisper-large-v3-turbo": { input: 0.04, output: 0, type: "asr" },
};

interface ProviderModel {
    id: string;
    input: number;
    output: number;
    type: string;
}

interface ProviderData {
    provider: string;
    source: string;
    lastUpdated: string;
    totalModels: number;
    models: ProviderModel[];
}

async function main(): Promise<void> {
    console.log(`[sync-${PROVIDER}] Starting ${PROVIDER} pricing sync...\n`);
    console.log(`[sync-${PROVIDER}] Using hardcoded pricing from groq.com/pricing\n`);

    const models: ProviderModel[] = Object.entries(GROQ_PRICING).map(([id, pricing]) => ({
        id,
        input: pricing.input,
        output: pricing.output,
        type: pricing.type,
    }));

    const data: ProviderData = {
        provider: PROVIDER,
        source: "https://groq.com/pricing/",
        lastUpdated: new Date().toISOString(),
        totalModels: models.length,
        models,
    };

    const outPath = path.join(__dirname, "..", "data", `${PROVIDER}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

    console.log(`[sync-${PROVIDER}] Results:`);
    console.log(`  Models with pricing: ${models.length}`);
    console.log(`\n[sync-${PROVIDER}] Wrote to ${outPath}`);
}

main().catch(console.error);
