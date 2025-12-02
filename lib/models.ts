import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { customProvider, type LanguageModel } from "ai";

// ASI:1 Provider (OpenAI-compatible)
// https://docs.asi1.ai/documentation/build-with-asi-one/openai-compatibility
const asiProvider = createOpenAICompatible({
  name: "asi",
  apiKey: process.env.ASI_API_KEY || "free-tier-key",
  baseURL: "https://api.asi1.ai/v1",
});

// Model provider configuration
// Maps model IDs to their AI SDK providers
// Updated November 2025 with latest models and accurate pricing
export const modelProvider = customProvider({
  languageModels: {
    // === MAINSTREAM MODELS ===
    // OpenAI
    "gpt-5.1": openai("gpt-5.1"),
    // Anthropic
    "claude-opus-4.5": anthropic("claude-opus-4.5"),
    "claude-sonnet-4.5": anthropic("claude-sonnet-4.5"),
    "claude-haiku-4.5": anthropic("claude-haiku-4.5"),
    // Google
    "gemini-3-pro": google("gemini-3-pro"),
    "gemini-2.0-flash": google("gemini-2.0-flash-exp"),
    
    // === ASI:1 MODELS ===
    // https://docs.asi1.ai/documentation/build-with-asi-one/openai-compatibility
    "asi1-mini": asiProvider("asi1-mini"),
    "asi1-fast": asiProvider("asi1-fast"),
    "asi1-extended": asiProvider("asi1-extended"),
    "asi1-agentic": asiProvider("asi1-agentic"),
    "asi1-graph": asiProvider("asi1-graph"),
    
    // === ASI CLOUD MODELS ===
    // https://asicloud.cudos.org/inference/models
    "google/gemma-3-27b-it": asiProvider("google/gemma-3-27b-it"),
    "openai/gpt-oss-20b": asiProvider("openai/gpt-oss-20b"),
    "nousresearch/hermes-4-70b": asiProvider("nousresearch/hermes-4-70b"),
    "meta-llama/llama-3.3-70b-instruct": asiProvider("meta-llama/llama-3.3-70b-instruct"),
    "mistralai/mistral-nemo": asiProvider("mistralai/mistral-nemo"),
    "qwen/qwen3-32b": asiProvider("qwen/qwen3-32b"),
    "z-ai/glm-4.5-air": asiProvider("z-ai/glm-4.5-air"),
  },
});

export type ModelID = Parameters<(typeof modelProvider)["languageModel"]>["0"];

// Model display names
export const MODEL_NAMES: Record<ModelID, string> = {
  // Mainstream
  "gpt-5.1": "GPT-5.1",
  "claude-opus-4.5": "Claude Opus 4.5",
  "claude-sonnet-4.5": "Claude Sonnet 4.5",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "gemini-3-pro": "Gemini 3 Pro",
  "gemini-2.0-flash": "Gemini 2.0 Flash",
  // ASI:1
  "asi1-mini": "ASI-1 Mini",
  "asi1-fast": "ASI-1 Fast",
  "asi1-extended": "ASI-1 Extended",
  "asi1-agentic": "ASI-1 Agentic",
  "asi1-graph": "ASI-1 Graph",
  // ASI Cloud
  "google/gemma-3-27b-it": "Gemma 3 27B",
  "openai/gpt-oss-20b": "GPT-OSS 20B",
  "nousresearch/hermes-4-70b": "Hermes 4 70B",
  "meta-llama/llama-3.3-70b-instruct": "Llama 3.3 70B",
  "mistralai/mistral-nemo": "Mistral Nemo",
  "qwen/qwen3-32b": "Qwen3 32B",
  "z-ai/glm-4.5-air": "GLM-4.5 Air",
};

// Price multipliers per model
// Base price: 1 wei = $0.000001 USDC per token = $1 per 1M tokens at 1x multiplier
// Formula: multiplier = 1 + real_cost_per_1M_tokens
// 
// === MAINSTREAM MODELS ===
// GPT-5.1: $1.25 input / $10.00 output = ~$5.63 avg → 1 + 5.63 = 6.63
// Claude Opus 4.5: $5.00 input / $25.00 output = ~$15.00 avg → 1 + 15.00 = 16.0
// Claude Sonnet 4.5: $3.00 input / $15.00 output = ~$9.00 avg → 1 + 9.00 = 10.0
// Claude Haiku 4.5: $1.00 input / $5.00 output = ~$3.00 avg → 1 + 3.00 = 4.0
// Gemini 3 Pro: $2.00 input / $12.00 output = ~$7.00 avg → 1 + 7.00 = 8.0
// Gemini 2.0 Flash: ~$0.50 avg → 1 + 0.50 = 1.5
//
// === ASI:1 MODELS ===
// All ASI:1 models: FREE for us, $1/1M tokens for users → 1 + 0 = 1.0
//
// === ASI CLOUD MODELS ===
// Source: https://docs.cudos.org/docs/asi-cloud/inference/pricing
// Gemma 3 27B: $0.09 input / $0.20 output = $0.29 → 1 + 0.29 = 1.29
// GPT-OSS 20B: $0.03 input / $0.13 output = $0.16 → 1 + 0.16 = 1.16
// Hermes 4 70B: $0.30 input / $0.43 output = $0.73 → 1 + 0.73 = 1.73
// Llama 3.3 70B: $0.30 input / $0.43 output = $0.73 → 1 + 0.73 = 1.73
// Mistral Nemo: $0.01 input / $0.04 output = $0.05 → 1 + 0.05 = 1.05
// Qwen3 32B: $0.17 input / $0.43 output = $0.60 → 1 + 0.60 = 1.60
// GLM-4.5 Air: $0.17 input / $0.93 output = $1.10 → 1 + 1.10 = 2.10
export const MODEL_PRICE_MULTIPLIERS: Record<ModelID, number> = {
  // Mainstream
  "gpt-5.1": 6.63,
  "claude-opus-4.5": 16.0,
  "claude-sonnet-4.5": 10.0,
  "claude-haiku-4.5": 4.0,
  "gemini-3-pro": 8.0,
  "gemini-2.0-flash": 1.5,
  // ASI:1
  "asi1-fast": 1.0,
  "asi1-extended": 1.0,
  "asi1-agentic": 1.0,
  "asi1-graph": 1.0,
  
  // ASI Cloud
  "asi1-mini": 1.0,
  "google/gemma-3-27b-it": 1.29,
  "openai/gpt-oss-20b": 1.16,
  "nousresearch/hermes-4-70b": 1.73,
  "meta-llama/llama-3.3-70b-instruct": 1.73,
  "mistralai/mistral-nemo": 1.05,
  "qwen/qwen3-32b": 1.60,
  "z-ai/glm-4.5-air": 2.10,
};

// Get model instance by ID
export function getModel(modelId: ModelID): LanguageModel {
  return modelProvider.languageModel(modelId);
}

// Calculate price for a model based on tokens
export function calculateModelPrice(modelId: ModelID, tokens: number, basePricePerToken: number): number {
  const multiplier = MODEL_PRICE_MULTIPLIERS[modelId] || 1.0;
  return Math.ceil(basePricePerToken * multiplier * tokens);
}

// Default model (ASI-1 Mini - best balance of performance and cost)
export const DEFAULT_MODEL: ModelID = "asi1-mini";

