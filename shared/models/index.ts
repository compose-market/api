/**
 * Models Module - Unified Exports
 * 
 * Clean, unified exports for all model-related functionality.
 * Inference functions are now in shared/api/gateway.ts (consolidated).
 * 
 * Usage:
 * ```typescript
 * import { 
 *   invokeUnified,
 *   getModelById,
 * } from "../models";
 * 
 * // For inference:
 * import { invokeUnified } from "../api/gateway.js";
 * ```
 * 
 * @module shared/models
 */

// =============================================================================
// Registry (Model Lookup)
// =============================================================================

export {
    getCompiledModels,
    getExtendedModels,
    getModelById,
    resolveModel,
    getModelSource,
    getModelCard,
    getAllModelCards,
    getModelRegistry,
    getModelInfo,
    getModelsBySource,
    getAvailableModels,
    refreshRegistry,
    getLanguageModel,
    calculateInferenceCost,
    calculateActionCost,
    calculateCost,
} from "./registry.js";

export type {
    ModelCard,
    ModelProvider,
    CompiledModelsData,
    ModelPricing,
    ResolvedModel,
} from "./registry.js";

// =============================================================================
// Types
// =============================================================================

export type {
    ModelCapability,
    TaskType,
    ModelPricing as Pricing,
    OpenAIProviderModel,
    GeminiProviderModel,
    HFProviderModel,
    OpenRouterProviderModel,
    RawModel,
} from "./types.js";

export { PROVIDER_PRIORITY } from "./types.js";

// =============================================================================
// Inference Functions (Re-exported from Gateway)
// =============================================================================

export {
    invokeUnified as invoke,
    invokeUnified as invokeChat,
    invokeImage,
    invokeVideo,
    invokeTTS,
    invokeASR,
    invokeEmbedding,
    submitVideoJob,
    checkVideoJobStatus,
} from "../inference/gateway.js";

export type {
    ChatMessage,
    ChatOptions,
    ChatResult,
    ImageOptions,
    ImageResult,
    VideoOptions,
    VideoResult,
    TTSOptions,
    ASROptions,
    ASRResult,
    EmbeddingOptions,
    EmbeddingResult,
    VideoJobResult,
    VideoJobStatus,
    TokenUsage,
} from "../inference/gateway.js";
