/**
 * Standardized Model Types
 * 
 * All models must pass 5-Pillar validation:
 * 1. Canonical ID (modelId)
 * 2. Human-Readable Name (name)
 * 3. Capabilities (array of positive capabilities)
 * 4. Task/Pipeline Type (taskType)
 * 5. Verified Pricing (pricing)
 */

// =============================================================================
// Provider Types
// =============================================================================

export type ModelProvider =
    | "google"
    | "openai"
    | "anthropic"
    | "asi-one"
    | "asi-cloud"
    | "openrouter"
    | "huggingface"
    | "aiml";

/**
 * Provider priority for deduplication and routing
 * Lower number = higher priority
 * Same number = tie (any can be used)
 */
export const PROVIDER_PRIORITY: Record<ModelProvider, number> = {
    "google": 1,
    "openai": 1,
    "anthropic": 1,
    "asi-cloud": 2,
    "openrouter": 3,
    "huggingface": 4,
    "aiml": 5,
    "asi-one": 6
};

// =============================================================================
// Capability Types
// =============================================================================

/**
 * Standard capability names
 * Only include capabilities the model SUPPORTS (positive).
 * Do NOT include capabilities with false values.
 */
export type ModelCapability =
    | "tools"              // Function calling
    | "reasoning"          // o1/DeepSeek-R1 style extended reasoning
    | "structured-outputs" // JSON mode / structured outputs
    | "vision"             // Image input understanding
    | "code-execution"     // Google's code execution tool
    | "search-grounding"   // Google Search grounding
    | "thinking"           // Extended thinking (Gemini thinking models)
    | "streaming"          // Streaming response support
    | "live-api"           // Real-time bidirectional (Live API)
    | "embeddings"         // Embedding model
    | "image-generation"   // Can generate images
    | "audio-generation"   // Can generate audio/TTS
    | "audio-understanding"// Can process audio input
    | "video-understanding"// Can process video input
    | "computer-use"       // Computer/browser control
    | "agentic";           // Agent orchestration capabilities

// =============================================================================
// Task Types
// =============================================================================

/**
 * Standard task/pipeline types
 * Determines the type of inference endpoint to use
 */
export type TaskType =
    | "text-generation"
    | "text-to-image"
    | "image-to-text"
    | "image-to-image"
    | "text-to-speech"
    | "speech-to-text"
    | "text-to-video"
    | "image-to-video"
    | "feature-extraction"  // Embeddings
    | "conversational"
    | "summarization"
    | "translation"
    | "question-answering"
    | "fill-mask"
    | "zero-shot-classification"
    | "text-classification"
    | "token-classification"
    | "audio-classification"
    | "automatic-speech-recognition"
    | "object-detection"
    | "image-segmentation"
    | "image-classification"
    | "depth-estimation"
    | "video-classification"
    | "unconditional-image-generation"
    | "text-to-audio"
    | "music-generation"
    | "deep-research";

// =============================================================================
// Pricing Types
// =============================================================================

export interface ModelPricing {
    input: number;    // USD per million tokens
    output: number;   // USD per million tokens
}

// =============================================================================
// ModelCard - The Canonical Model Schema
// =============================================================================

/**
 * ModelCard - Standardized model representation
 * 
 * All fields derived from provider JSONs at compile time.
 * Missing fields are filled by merging data from multiple providers.
 */
export interface ModelCard {
    // =========================================================================
    // 5-Pillar Core Fields (Required for valid model)
    // =========================================================================

    /** Canonical ID for API calls */
    modelId: string;

    /** Human-readable display name */
    name: string;

    /** Routing provider (determines which API/credentials to use) */
    provider: ModelProvider;

    /** Primary task type */
    taskType: TaskType | string;

    /** Array of supported capabilities (positive only) */
    capabilities: ModelCapability[];

    /** Pricing per million tokens (null if free or unknown) */
    pricing: ModelPricing | null;

    // =========================================================================
    // Extended Metadata (Optional, merged from all sources)
    // =========================================================================

    /** Model description */
    description?: string;

    /** Input token limit */
    contextWindow?: number;

    /** Output token limit */
    maxOutputTokens?: number;

    /** Organization that owns/created the model */
    ownedBy?: string;

    /** Creation timestamp */
    createdAt?: string | number;

    /** Input modalities (text, image, audio, video) */
    inputModalities?: string[];

    /** Output modalities */
    outputModalities?: string[];

    // =========================================================================
    // HuggingFace Inference Provider Routing
    // =========================================================================

    /** HuggingFace Inference Provider (e.g., "fal-ai", "replicate", "together") */
    hfInferenceProvider?: string;

    /** Provider-specific model ID for HF Router (e.g., "fal-ai/flux/schnell") */
    hfProviderId?: string;

    // =========================================================================
    // Availability & Source Tracking
    // =========================================================================

    /** Whether model is available for inference */
    available: boolean;

    /** All providers where this model is available (for reference) */
    availableFrom?: ModelProvider[];
}

// =============================================================================
// Compiled Models Data Structure
// =============================================================================

export interface CompiledModelsData {
    lastUpdated: string;
    totalModels: number;
    byProvider: Record<ModelProvider, number>;
    byTaskType: Record<string, number>;
    models: ModelCard[];
}

// =============================================================================
// Provider JSON Schemas (for parsing source files)
// =============================================================================

/**
 * OpenAI provider JSON model entry
 */
export interface OpenAIProviderModel {
    model: {
        name: string;
        modelId: string;
        context_window?: {
            tokens?: number | null;
            max_output_tokens?: number | null;
        };
        capabilities?: {
            reasoning?: boolean | null;
            agentic?: boolean | null;
            can_use_tools?: boolean;
            image_generation?: boolean;
            image_understanding?: boolean;
            audio_generation?: boolean;
            audio_understanding?: boolean;
            video_generation?: boolean;
            video_understanding?: boolean;
            computer_use?: boolean;
            embeddings?: boolean;
            moderation?: boolean;
            transcription?: boolean;
            tts?: boolean;
            coding?: boolean | null;
        };
        task_type_pipeline?: {
            task_types?: string[] | null;
            pipelines?: string[];
            api_endpoints?: string[];
        };
        prices?: {
            text_tokens?: {
                standard?: {
                    input?: number;
                    output?: number;
                };
            };
            legacy_text_tokens?: {
                standard?: {
                    input?: number;
                    output?: number;
                };
            };
            image_generation_per_image?: object;
        };
    };
}

/**
 * Gemini provider JSON model entry
 */
export interface GeminiProviderModel {
    name: string;
    modelId: string;
    supportedDataTypes?: {
        inputs?: string[];
        outputs?: string[];
    };
    contextWindow?: {
        inputTokens?: number | null;
        outputTokens?: number | null;
    };
    capabilities?: {
        thinking?: boolean;
        functionCalling?: boolean;
        codeExecution?: boolean;
        searchGrounding?: boolean;
        structuredOutputs?: boolean;
        imageGeneration?: boolean;
        audioGeneration?: boolean;
        liveApi?: boolean;
        embeddings?: boolean;
    };
    prices?: {
        unit?: string;
        input?: number | null;
        output?: number | null;
        tiers?: Array<{
            condition?: string;
            input?: number;
            output?: number;
        }>;
    };
    knowledgeCutoff?: string;
}

/**
 * HuggingFace provider JSON model entry (from hf.json)
 */
export interface HFProviderModel {
    name: string;
    modelId: string;
    taskTypes?: string[];
    capabilities?: {
        supportsTools?: Record<string, boolean>;
        supportsStructuredOutput?: Record<string, boolean>;
        reasoning?: boolean | null;
    };
    contextWindow?: {
        byProvider?: Record<string, number>;
        inferredFromConfig?: number | null;
        source?: "router" | "config" | "unknown";
    };
    providers?: Array<{
        provider: string;
        status?: string | null;
        providerId?: string | null;
        task?: string | null;
        pricing?: {
            inputPer1M: number;
            outputPer1M: number;
        } | null;
        contextLength?: number | null;
        supportsTools?: boolean | null;
        supportsStructuredOutput?: boolean | null;
    }>;
    prices?: {
        cheapest?: {
            provider: string;
            inputPer1M: number;
            outputPer1M: number;
            currency: string;
        } | null;
        byProvider?: Record<string, { inputPer1M: number; outputPer1M: number }>;
    };
}

/**
 * OpenRouter provider JSON model entry
 */
export interface OpenRouterProviderModel {
    id: string;
    name: string;
    description?: string;
    context_length?: number;
    pricing?: {
        prompt?: string | number;
        completion?: string | number;
    };
    top_provider?: {
        context_length?: number;
        max_completion_tokens?: number | null;
    };
    per_request_limits?: object | null;
    architecture?: {
        modality?: string;
        input_modalities?: string[];
        output_modalities?: string[];
        tokenizer?: string;
        instruct_type?: string | null;
    };
    supported_parameters?: string[];
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Intermediate model representation during sync
 * Before deduplication and merging
 */
export interface RawModel {
    modelId: string;
    name: string;
    provider: ModelProvider;
    taskType: string;
    capabilities: ModelCapability[];
    pricing: ModelPricing | null;
    description?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    ownedBy?: string;
    createdAt?: string | number;
    inputModalities?: string[];
    outputModalities?: string[];
    /** HuggingFace Inference Provider (e.g., "fal-ai", "replicate", "together") */
    hfInferenceProvider?: string;
    /** Provider-specific model ID for HF Router */
    hfProviderId?: string;
}
