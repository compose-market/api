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

export interface OpenAIModelObject {
    id: string;
    object: "model";
    created: number;
    owned_by: string;
}

export interface OpenAIModelDetails extends OpenAIModelObject {
    // Extended fields from ModelCard
    provider?: string;  // Explicit provider for routing (e.g., "openai", "google", "huggingface")
    name?: string;
    description?: string;
    context_window?: number;
    max_output_tokens?: number;
    capabilities?: string[];
    pricing?: {
        input: number;
        output: number;
    };
    task_type?: string;
    input_modalities?: string[];
    output_modalities?: string[];
}

export interface ModelsListResponse {
    object: "list";
    data: OpenAIModelObject[];
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
