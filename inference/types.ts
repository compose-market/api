/**
 * OpenAI API v1 Type Definitions
 * 
 * Complete type definitions for OpenAI-compatible API endpoints.
 * Used for standardizing responses across all providers.
 */

// =============================================================================
// Common Types
// =============================================================================

export interface OpenAIUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface OpenAIError {
    error: {
        message: string;
        type: string;
        param: string | null;
        code: string | null;
    };
}

// =============================================================================
// Chat Completions (/v1/chat/completions)
// =============================================================================

export type ChatRole = "system" | "user" | "assistant" | "tool" | "function";

export interface ChatMessage {
    role: ChatRole;
    content: string | ChatContentPart[] | null;
    name?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export interface ChatContentPart {
    type: "text" | "image_url";
    text?: string;
    image_url?: {
        url: string;
        detail?: "auto" | "low" | "high";
    };
}

export interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

export interface ChatCompletionRequest {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    top_p?: number;
    n?: number;
    stream?: boolean;
    stop?: string | string[];
    max_tokens?: number;
    max_completion_tokens?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    logit_bias?: Record<string, number>;
    user?: string;
    tools?: Tool[];
    tool_choice?: "none" | "auto" | "required" | ToolChoice;
    response_format?: ResponseFormat;
    seed?: number;
}

export interface Tool {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        strict?: boolean;
    };
}

export interface ToolChoice {
    type: "function";
    function: {
        name: string;
    };
}

export interface ResponseFormat {
    type: "text" | "json_object" | "json_schema";
    json_schema?: {
        name: string;
        schema: Record<string, unknown>;
        strict?: boolean;
    };
}

export interface ChatCompletionChoice {
    index: number;
    message: ChatMessage;
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
    logprobs?: object | null;
}

export interface ChatCompletionResponse {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: ChatCompletionChoice[];
    usage: OpenAIUsage;
    system_fingerprint?: string;
}

// Streaming types
export interface ChatCompletionChunk {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    system_fingerprint?: string;
    choices: ChatCompletionChunkChoice[];
    usage?: OpenAIUsage | null;
}

export interface ChatCompletionChunkChoice {
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
    logprobs?: object | null;
}

// =============================================================================
// Images (/v1/images/generations, /v1/images/edits, /v1/images/variations)
// =============================================================================

export interface ImageGenerationRequest {
    prompt: string;
    model?: string;
    n?: number;
    quality?: "standard" | "hd";
    response_format?: "url" | "b64_json";
    size?: "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792";
    style?: "vivid" | "natural";
    user?: string;
}

export interface ImageEditRequest {
    image: string;  // base64 or URL
    prompt: string;
    mask?: string;  // base64 or URL
    model?: string;
    n?: number;
    size?: string;
    response_format?: "url" | "b64_json";
    user?: string;
}

export interface ImageVariationRequest {
    image: string;  // base64 or URL
    model?: string;
    n?: number;
    response_format?: "url" | "b64_json";
    size?: string;
    user?: string;
}

export interface ImageData {
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
}

export interface ImagesResponse {
    id?: string;
    created: number;
    data: ImageData[];
}

// =============================================================================
// Audio Speech (/v1/audio/speech)
// =============================================================================

export interface AudioSpeechRequest {
    model: string;
    input: string;
    voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" | string;
    response_format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
    speed?: number;  // 0.25 to 4.0
}

// Response is audio binary with Content-Type header

// =============================================================================
// Audio Transcriptions (/v1/audio/transcriptions)
// =============================================================================

export interface AudioTranscriptionRequest {
    file: string;  // base64 audio or file path
    model: string;
    language?: string;
    prompt?: string;
    response_format?: "json" | "text" | "srt" | "verbose_json" | "vtt";
    temperature?: number;
    timestamp_granularities?: ("word" | "segment")[];
}

export interface TranscriptionWord {
    word: string;
    start: number;
    end: number;
}

export interface TranscriptionSegment {
    id: number;
    seek: number;
    start: number;
    end: number;
    text: string;
    tokens: number[];
    temperature: number;
    avg_logprob: number;
    compression_ratio: number;
    no_speech_prob: number;
}

export interface AudioTranscriptionResponse {
    text: string;
    task?: string;
    language?: string;
    duration?: number;
    words?: TranscriptionWord[];
    segments?: TranscriptionSegment[];
}

// =============================================================================
// Audio Translations (/v1/audio/translations)
// =============================================================================

export interface AudioTranslationRequest {
    file: string;  // base64 audio
    model: string;
    prompt?: string;
    response_format?: "json" | "text" | "srt" | "verbose_json" | "vtt";
    temperature?: number;
}

export interface AudioTranslationResponse {
    text: string;
}

// =============================================================================
// Embeddings (/v1/embeddings)
// =============================================================================

export interface EmbeddingRequest {
    input: string | string[];
    model: string;
    encoding_format?: "float" | "base64";
    dimensions?: number;
    user?: string;
}

export interface EmbeddingData {
    object: "embedding";
    embedding: number[];
    index: number;
}

export interface EmbeddingResponse {
    object: "list";
    data: EmbeddingData[];
    model: string;
    usage: {
        prompt_tokens: number;
        total_tokens: number;
    };
}

// =============================================================================
// Videos (/v1/videos/generations) - Extended endpoint
// =============================================================================

export interface VideoGenerationRequest {
    prompt: string;
    model: string;
    image?: string;  // base64 for image-to-video (OpenAI style)
    image_url?: string;  // URL for image-to-video (AIML style)
    duration?: number;  // seconds
    fps?: number;
    size?: string;  // e.g., "1920x1080"
    aspect_ratio?: string;  // e.g., "16:9"
    user?: string;
}

export interface VideoData {
    url?: string;
    b64_json?: string;
    duration?: number;
}

export interface VideoGenerationResponse {
    id?: string;
    created: number;
    data: VideoData[];
    model: string;
}

// Video generation is often async, so also need status endpoints
export interface VideoGenerationStatus {
    id: string;
    status: "pending" | "processing" | "completed" | "failed";
    created: number;
    completed?: number;
    result?: VideoData;
    error?: string;
}

// =============================================================================
// Models (/v1/models)
// =============================================================================

export interface ModelsListResponse {
    object: "list";
    data: ModelCard[];
}

// =============================================================================
// Moderations (/v1/moderations)
// =============================================================================

export interface ModerationRequest {
    input: string | string[];
    model?: string;
}

export interface ModerationCategories {
    hate: boolean;
    "hate/threatening": boolean;
    harassment: boolean;
    "harassment/threatening": boolean;
    "self-harm": boolean;
    "self-harm/intent": boolean;
    "self-harm/instructions": boolean;
    sexual: boolean;
    "sexual/minors": boolean;
    violence: boolean;
    "violence/graphic": boolean;
}

export interface ModerationCategoryScores {
    hate: number;
    "hate/threatening": number;
    harassment: number;
    "harassment/threatening": number;
    "self-harm": number;
    "self-harm/intent": number;
    "self-harm/instructions": number;
    sexual: number;
    "sexual/minors": number;
    violence: number;
    "violence/graphic": number;
}

export interface ModerationResult {
    flagged: boolean;
    categories: ModerationCategories;
    category_scores: ModerationCategoryScores;
}

export interface ModerationResponse {
    id: string;
    model: string;
    results: ModerationResult[];
}

// =============================================================================
// Legacy Completions (/v1/completions)
// =============================================================================

export interface CompletionRequest {
    model: string;
    prompt: string | string[];
    suffix?: string;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    n?: number;
    stream?: boolean;
    logprobs?: number;
    echo?: boolean;
    stop?: string | string[];
    presence_penalty?: number;
    frequency_penalty?: number;
    best_of?: number;
    logit_bias?: Record<string, number>;
    user?: string;
}

export interface CompletionChoice {
    text: string;
    index: number;
    logprobs: object | null;
    finish_reason: "stop" | "length" | null;
}

export interface CompletionResponse {
    id: string;
    object: "text_completion";
    created: number;
    model: string;
    choices: CompletionChoice[];
    usage: OpenAIUsage;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Generate a unique completion ID
 */
export function generateCompletionId(): string {
    return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generate a unique image ID
 */
export function generateImageId(): string {
    return `img-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generate a unique video ID
 */
export function generateVideoId(): string {
    return `vid-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generate a unique moderation ID
 */
export function generateModerationId(): string {
    return `modr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Format SSE data for streaming responses
 */
export function formatSSE(data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Format SSE done signal
 */
export function formatSSEDone(): string {
    return `data: [DONE]\n\n`;
}

/**
 * Create an OpenAI-format error response
 */
export function createErrorResponse(
    message: string,
    type: string = "invalid_request_error",
    code: string | null = null,
    param: string | null = null
): OpenAIError {
    return {
        error: {
            message,
            type,
            param,
            code,
        },
    };
}


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
    | "gemini"
    | "openai"
    | "asicloud"
    | "hugging face"
    | "aiml"
    | "vertex"
    | "fireworks"
    | "cloudflare"
    | "deepgram"
    | "elevenlabs"
    | "cartesia"
    | "roboflow";

/**
 * Provider priority for deduplication and routing
 * Lower number = higher priority
 * Same number = tie (any can be used)
 */
export const PROVIDER_PRIORITY: Record<ModelProvider, number> = {
    "gemini": 1,
    "openai": 1,
    "vertex": 1,
    "hugging face": 2,
    "fireworks": 2,
    "deepgram": 2,
    "elevenlabs": 2,
    "cartesia": 2,
    "aiml": 3,
    "asicloud": 3,
    "cloudflare": 3,
    "roboflow": 3,
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

export type ModelPricing = Record<string, unknown>;

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
    /** Canonical ID for inference calls. */
    modelId: string;
    /** Human-readable display name. */
    name: string | null;
    /** Provider family from the compiled provider catalog. */
    provider: ModelProvider;
    /** Canonical task/modality/pipeline field from the compiled catalog. */
    type: string | string[] | null;
    /** Raw model description from the compiled catalog. */
    description: string | null;
    /** Raw input field from the compiled catalog. */
    input: unknown | null;
    /** Raw output field from the compiled catalog. */
    output: unknown | null;
    /** Raw context window field from the compiled catalog. */
    contextWindow: number | Record<string, unknown> | null;
    /** Raw pricing field from the compiled catalog. */
    pricing: ModelPricing | null;
    /** Optional output token limit when also carried separately. */
    maxOutputTokens?: number;
    /** Optional owner metadata. */
    ownedBy?: string;
    /** Optional creation timestamp. */
    createdAt?: string | number;
    /** Optional capability metadata if compiled in later. */
    capabilities?: ModelCapability[];
    /** Optional Hugging Face router provider. */
    hfInferenceProvider?: string;
    /** Optional provider-specific model ID for HF Router. */
    hfProviderId?: string;
    /** Optional availability bit if compiled in later. */
    available?: boolean;
    /** Optional source tracking. */
    availableFrom?: ModelProvider[];
}

// =============================================================================
// Compiled Models Data Structure
// =============================================================================

export interface CompiledModelsData {
    lastUpdated: string;
    totalModels: number;
    byProvider: Record<ModelProvider, number>;
    byType: Record<string, number>;
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
 * Cloudflare provider JSON model entry
 */
export interface CloudflareProviderModel {
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
