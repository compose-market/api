import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { customProvider, type LanguageModel } from "ai";

// =============================================================================
// Provider Configuration
// =============================================================================

/**
 * API Key Strategy:
 * - OPENAI_API_KEY → OpenAI mainstream models (GPT-5.1)
 * - ANTHROPIC_API_KEY → Anthropic mainstream models (Claude)
 * - GOOGLE_GENERATIVE_AI_API_KEY → Google mainstream models (Gemini)
 * - ASI_ONE_API_KEY → ASI:1 models (asi1-fast, asi1-extended, asi1-agentic, asi1-graph)
 * - ASI_INFERENCE_API_KEY → ASI Cloud OSS models + asi1-mini (default model)
 * - HUGGING_FACE_INFERENCE_TOKEN → HuggingFace inference models
 */

// ASI:1 Provider (OpenAI-compatible) - uses ASI_ONE_API_KEY
// https://docs.asi1.ai/documentation/build-with-asi-one/openai-compatibility
// For: asi1-fast, asi1-extended, asi1-agentic, asi1-graph
const asiOneProvider = createOpenAICompatible({
  name: "asi-one",
  apiKey: process.env.ASI_ONE_API_KEY || "",
  baseURL: "https://api.asi1.ai/v1",
});

// ASI Cloud Provider (for OSS models + asi1-mini) - uses ASI_INFERENCE_API_KEY
// https://asicloud.cudos.org/inference/models
// For: asi1-mini (default), and all OSS models (llama, mistral, qwen, etc.)
const asiCloudProvider = createOpenAICompatible({
  name: "asi-cloud",
  apiKey: process.env.ASI_INFERENCE_API_KEY || "",
  baseURL: "https://api.cudos.org/v1",
});

// =============================================================================
// Model Provider Configuration
// =============================================================================

// Maps model IDs to their AI SDK providers
// Updated December 2025 with latest models and accurate pricing
export const modelProvider = customProvider({
  languageModels: {
    // === MAINSTREAM MODELS ===
    // OpenAI (uses OPENAI_API_KEY)
    "gpt-5.1": openai("gpt-5.1"),
    // Anthropic (uses ANTHROPIC_API_KEY)
    "claude-opus-4.5": anthropic("claude-opus-4.5"),
    "claude-sonnet-4.5": anthropic("claude-sonnet-4.5"),
    "claude-haiku-4.5": anthropic("claude-haiku-4.5"),
    // Google (uses GOOGLE_GENERATIVE_AI_API_KEY)
    "gemini-3-pro": google("gemini-3-pro"),
    "gemini-2.0-flash": google("gemini-2.0-flash-exp"),
    
    // === ASI:1 MODELS (uses ASI_ONE_API_KEY) ===
    // https://docs.asi1.ai/documentation/build-with-asi-one/openai-compatibility
    // NOTE: asi1-mini uses ASI_INFERENCE_API_KEY (ASI Cloud), not ASI_ONE_API_KEY
    "asi1-fast": asiOneProvider("asi1-fast"),
    "asi1-extended": asiOneProvider("asi1-extended"),
    "asi1-agentic": asiOneProvider("asi1-agentic"),
    "asi1-graph": asiOneProvider("asi1-graph"),
    
    // === ASI CLOUD OSS MODELS + asi1-mini (uses ASI_INFERENCE_API_KEY) ===
    // https://asicloud.cudos.org/inference/models
    "asi1-mini": asiCloudProvider("asi1-mini"), // Default model - on ASI Cloud
    "google/gemma-3-27b-it": asiCloudProvider("google/gemma-3-27b-it"),
    "openai/gpt-oss-20b": asiCloudProvider("openai/gpt-oss-20b"),
    "nousresearch/hermes-4-70b": asiCloudProvider("nousresearch/hermes-4-70b"),
    "meta-llama/llama-3.3-70b-instruct": asiCloudProvider("meta-llama/llama-3.3-70b-instruct"),
    "mistralai/mistral-nemo": asiCloudProvider("mistralai/mistral-nemo"),
    "qwen/qwen3-32b": asiCloudProvider("qwen/qwen3-32b"),
    "z-ai/glm-4.5-air": asiCloudProvider("z-ai/glm-4.5-air"),
  },
});

export type ModelID = Parameters<(typeof modelProvider)["languageModel"]>["0"];

// =============================================================================
// Model Metadata
// =============================================================================

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
  "asi1-fast": "ASI-1 Fast",
  "asi1-extended": "ASI-1 Extended",
  "asi1-agentic": "ASI-1 Agentic",
  "asi1-graph": "ASI-1 Graph",
  // ASI Cloud (includes asi1-mini)
  "asi1-mini": "ASI-1 Mini",
  "google/gemma-3-27b-it": "Gemma 3 27B",
  "openai/gpt-oss-20b": "GPT-OSS 20B",
  "nousresearch/hermes-4-70b": "Hermes 4 70B",
  "meta-llama/llama-3.3-70b-instruct": "Llama 3.3 70B",
  "mistralai/mistral-nemo": "Mistral Nemo",
  "qwen/qwen3-32b": "Qwen3 32B",
  "z-ai/glm-4.5-air": "GLM-4.5 Air",
};

// Model provider types for routing
export type ModelProviderType = "openai" | "anthropic" | "google" | "asi-one" | "asi-cloud" | "huggingface";

// Map model IDs to their provider types
export const MODEL_PROVIDERS: Record<ModelID, ModelProviderType> = {
  // Mainstream (each uses their own API key)
  "gpt-5.1": "openai",
  "claude-opus-4.5": "anthropic",
  "claude-sonnet-4.5": "anthropic",
  "claude-haiku-4.5": "anthropic",
  "gemini-3-pro": "google",
  "gemini-2.0-flash": "google",
  // ASI:1 (uses ASI_ONE_API_KEY) - EXCLUDING asi1-mini
  "asi1-fast": "asi-one",
  "asi1-extended": "asi-one",
  "asi1-agentic": "asi-one",
  "asi1-graph": "asi-one",
  // ASI Cloud OSS + asi1-mini (uses ASI_INFERENCE_API_KEY)
  "asi1-mini": "asi-cloud", // Default model is on ASI Cloud
  "google/gemma-3-27b-it": "asi-cloud",
  "openai/gpt-oss-20b": "asi-cloud",
  "nousresearch/hermes-4-70b": "asi-cloud",
  "meta-llama/llama-3.3-70b-instruct": "asi-cloud",
  "mistralai/mistral-nemo": "asi-cloud",
  "qwen/qwen3-32b": "asi-cloud",
  "z-ai/glm-4.5-air": "asi-cloud",
};

// Price multipliers per model
export const MODEL_PRICE_MULTIPLIERS: Record<ModelID, number> = {
  // Mainstream
  "gpt-5.1": 6.63,
  "claude-opus-4.5": 16.0,
  "claude-sonnet-4.5": 10.0,
  "claude-haiku-4.5": 4.0,
  "gemini-3-pro": 8.0,
  "gemini-2.0-flash": 1.5,
  // ASI:1 (ASI_ONE_API_KEY)
  "asi1-fast": 1.0,
  "asi1-extended": 1.0,
  "asi1-agentic": 1.0,
  "asi1-graph": 1.0,
  // ASI Cloud (ASI_INFERENCE_API_KEY)
  "asi1-mini": 1.0,
  "google/gemma-3-27b-it": 1.29,
  "openai/gpt-oss-20b": 1.16,
  "nousresearch/hermes-4-70b": 1.73,
  "meta-llama/llama-3.3-70b-instruct": 1.73,
  "mistralai/mistral-nemo": 1.05,
  "qwen/qwen3-32b": 1.60,
  "z-ai/glm-4.5-air": 2.10,
};

// =============================================================================
// Helper Functions
// =============================================================================

// Get model instance by ID
export function getModel(modelId: ModelID): LanguageModel {
  return modelProvider.languageModel(modelId);
}

// Get provider type for a model
export function getModelProvider(modelId: ModelID): ModelProviderType {
  return MODEL_PROVIDERS[modelId] || "asi-cloud";
}

// Check if a model ID is valid
export function isValidModelId(modelId: string): modelId is ModelID {
  return modelId in MODEL_NAMES;
}

// Calculate price for a model based on tokens
export function calculateModelPrice(modelId: ModelID, tokens: number, basePricePerToken: number): number {
  const multiplier = MODEL_PRICE_MULTIPLIERS[modelId] || 1.0;
  return Math.ceil(basePricePerToken * multiplier * tokens);
}

// Check if required API key is available for a model
export function isModelAvailable(modelId: ModelID): boolean {
  const provider = MODEL_PROVIDERS[modelId];
  switch (provider) {
    case "openai":
      return !!process.env.OPENAI_API_KEY;
    case "anthropic":
      return !!process.env.ANTHROPIC_API_KEY;
    case "google":
      return !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    case "asi-one":
      return !!process.env.ASI_ONE_API_KEY;
    case "asi-cloud":
      return !!process.env.ASI_INFERENCE_API_KEY;
    case "huggingface":
      return !!process.env.HUGGING_FACE_INFERENCE_TOKEN;
    default:
      return false;
  }
}

// Get list of available models (those with configured API keys)
export function getAvailableModels(): ModelID[] {
  return (Object.keys(MODEL_NAMES) as ModelID[]).filter(isModelAvailable);
}

// Default model (ASI-1 Mini - uses ASI_INFERENCE_API_KEY via ASI Cloud)
export const DEFAULT_MODEL: ModelID = "asi1-mini";
