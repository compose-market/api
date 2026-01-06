/**
 * HuggingFace Inference API (hf-inference) Pricing Sync
 * 
 * This is HuggingFace's own inference service - compute-time based pricing
 * Output: hf-inference.json
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROVIDER = "hf-inference";

// HF Inference - priced by compute time, approximated per-model
// Many models are free-tier, some have compute costs
// Source: https://huggingface.co/docs/inference-providers/pricing
const HF_INFERENCE_PRICING: Record<string, { input: number; output: number; type: string }> = {
    // Most HF inference is free or compute-based
    // These are approximate based on compute time costs
    "meta-llama/Llama-3.1-8B-Instruct": { input: 0.05, output: 0.05, type: "llm" },
    "microsoft/Phi-3-mini-4k-instruct": { input: 0.02, output: 0.02, type: "llm" },
    "google/gemma-2-2b-it": { input: 0.02, output: 0.02, type: "llm" },
    "mistralai/Mistral-7B-Instruct-v0.3": { input: 0.03, output: 0.03, type: "llm" },
    // Embedding models
    "sentence-transformers/all-MiniLM-L6-v2": { input: 0.01, output: 0, type: "embedding" },
    "BAAI/bge-small-en-v1.5": { input: 0.01, output: 0, type: "embedding" },
};

interface ProviderModel { id: string; input: number; output: number; type: string; }
interface ProviderData { provider: string; source: string; lastUpdated: string; totalModels: number; models: ProviderModel[]; }

async function main(): Promise<void> {
    const models: ProviderModel[] = Object.entries(HF_INFERENCE_PRICING).map(([id, p]) => ({ id, ...p }));
    const data: ProviderData = { provider: PROVIDER, source: "https://huggingface.co/docs/inference-providers/pricing", lastUpdated: new Date().toISOString(), totalModels: models.length, models };
    const outPath = path.join(__dirname, "..", "data", `${PROVIDER}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`[sync-${PROVIDER}] Models: ${models.length}`);
}

main().catch(console.error);
