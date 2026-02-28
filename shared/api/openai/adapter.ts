/**
 * OpenAI API Adapter
 * 
 * Transforms provider-specific responses into OpenAI-compatible format.
 * Handles streaming, error mapping, and response normalization.
 */

import type {
    ChatCompletionResponse,
    ChatCompletionChunk,
    ChatCompletionChoice,
    ChatCompletionChunkChoice,
    ImagesResponse,
    ImageData,
    AudioTranscriptionResponse,
    EmbeddingResponse,
    EmbeddingData,
    VideoGenerationResponse,
    VideoData,
    OpenAIUsage,
    OpenAIError,
} from "./types.js";

import {
    generateCompletionId,
    generateImageId,
    generateVideoId,
    formatSSE,
    formatSSEDone,
    createErrorResponse,
} from "./types.js";

// Re-export helper functions for convenience
export {
    generateCompletionId,
    generateImageId,
    generateVideoId,
    formatSSE,
    formatSSEDone,
    createErrorResponse,
} from "./types.js";

// =============================================================================
// Chat Completion Adapters
// =============================================================================

export interface RawChatResponse {
    content?: string;
    text?: string;
    message?: string;
    toolCalls?: Array<{
        id?: string;
        name: string;
        arguments: string | object;
    }>;
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        inputTokens?: number;
        outputTokens?: number;
    };
    finishReason?: string;
    model?: string;
}

/**
 * Adapt any provider's chat response to OpenAI format
 */
export function adaptChatResponse(
    raw: RawChatResponse,
    model: string,
    requestId?: string
): ChatCompletionResponse {
    const id = requestId || `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const content = raw.content || raw.text || raw.message || "";

    // Map finish reason
    let finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null = "stop";
    if (raw.finishReason) {
        const reason = raw.finishReason.toLowerCase();
        if (reason.includes("length") || reason.includes("max")) {
            finishReason = "length";
        } else if (reason.includes("tool") || reason.includes("function")) {
            finishReason = "tool_calls";
        } else if (reason.includes("filter") || reason.includes("content")) {
            finishReason = "content_filter";
        }
    }

    // Build choice
    const choice: ChatCompletionChoice = {
        index: 0,
        message: {
            role: "assistant",
            content,
        },
        finish_reason: finishReason,
        logprobs: null,
    };

    // Add tool calls if present
    if (raw.toolCalls && raw.toolCalls.length > 0) {
        choice.message.tool_calls = raw.toolCalls.map((tc, i) => ({
            id: tc.id || `call_${i}`,
            type: "function" as const,
            function: {
                name: tc.name,
                arguments: typeof tc.arguments === "string"
                    ? tc.arguments
                    : JSON.stringify(tc.arguments),
            },
        }));
        choice.finish_reason = "tool_calls";
    }

    // Extract usage
    const usage: OpenAIUsage = {
        prompt_tokens: raw.usage?.promptTokens || raw.usage?.inputTokens || 0,
        completion_tokens: raw.usage?.completionTokens || raw.usage?.outputTokens || 0,
        total_tokens: raw.usage?.totalTokens ||
            ((raw.usage?.promptTokens || raw.usage?.inputTokens || 0) +
                (raw.usage?.completionTokens || raw.usage?.outputTokens || 0)),
    };

    return {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: raw.model || model,
        choices: [choice],
        usage,
    };
}

/**
 * Adapt streaming text delta to OpenAI chunk format
 */
export function adaptStreamChunk(
    delta: string,
    model: string,
    id: string,
    isLast: boolean = false,
    finishReason: "stop" | "length" | null = null
): ChatCompletionChunk {
    const choice: ChatCompletionChunkChoice = {
        index: 0,
        delta: isLast ? {} : { content: delta },
        finish_reason: isLast ? (finishReason || "stop") : null,
        logprobs: null,
    };

    return {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [choice],
    };
}

// =============================================================================
// Image Generation Adapters
// =============================================================================

export interface RawImageResponse {
    images?: Array<{
        url?: string;
        base64?: string;
        b64_json?: string;
        revisedPrompt?: string;
        revised_prompt?: string;
    }>;
    url?: string;
    base64?: string;
    b64_json?: string;
    data?: string;  // Sometimes raw base64
}

/**
 * Adapt any provider's image response to OpenAI format
 */
export function adaptImageResponse(raw: RawImageResponse): ImagesResponse {
    const data: ImageData[] = [];

    if (raw.images && raw.images.length > 0) {
        for (const img of raw.images) {
            data.push({
                url: img.url,
                b64_json: img.b64_json || img.base64,
                revised_prompt: img.revised_prompt || img.revisedPrompt,
            });
        }
    } else if (raw.url || raw.base64 || raw.b64_json || raw.data) {
        data.push({
            url: raw.url,
            b64_json: raw.b64_json || raw.base64 || raw.data,
        });
    }

    return {
        id: generateImageId(),
        created: Math.floor(Date.now() / 1000),
        data,
    };
}

// =============================================================================
// Audio Transcription Adapters
// =============================================================================

export interface RawTranscriptionResponse {
    text?: string;
    transcript?: string;
    result?: string;
    language?: string;
    duration?: number;
    words?: Array<{
        word: string;
        start: number;
        end: number;
    }>;
    segments?: Array<{
        text: string;
        start: number;
        end: number;
    }>;
}

/**
 * Adapt any provider's transcription response to OpenAI format
 */
export function adaptTranscriptionResponse(
    raw: RawTranscriptionResponse
): AudioTranscriptionResponse {
    return {
        text: raw.text || raw.transcript || raw.result || "",
        language: raw.language,
        duration: raw.duration,
        words: raw.words,
    };
}

// =============================================================================
// Embedding Adapters
// =============================================================================

export interface RawEmbeddingResponse {
    embedding?: number[];
    embeddings?: number[][] | number[];
    data?: Array<{
        embedding: number[];
        index?: number;
    }>;
    vector?: number[];
}

/**
 * Adapt any provider's embedding response to OpenAI format
 */
export function adaptEmbeddingResponse(
    raw: RawEmbeddingResponse,
    model: string,
    inputTokens: number = 0
): EmbeddingResponse {
    const data: EmbeddingData[] = [];

    if (raw.data && Array.isArray(raw.data)) {
        for (let i = 0; i < raw.data.length; i++) {
            data.push({
                object: "embedding",
                embedding: raw.data[i].embedding,
                index: raw.data[i].index ?? i,
            });
        }
    } else if (raw.embeddings) {
        // Handle array of embeddings or single embedding
        const embeddings = Array.isArray(raw.embeddings[0])
            ? raw.embeddings as number[][]
            : [raw.embeddings as number[]];

        for (let i = 0; i < embeddings.length; i++) {
            data.push({
                object: "embedding",
                embedding: embeddings[i],
                index: i,
            });
        }
    } else if (raw.embedding) {
        data.push({
            object: "embedding",
            embedding: raw.embedding,
            index: 0,
        });
    } else if (raw.vector) {
        data.push({
            object: "embedding",
            embedding: raw.vector,
            index: 0,
        });
    }

    return {
        object: "list",
        data,
        model,
        usage: {
            prompt_tokens: inputTokens,
            total_tokens: inputTokens,
        },
    };
}

// =============================================================================
// Video Generation Adapters
// =============================================================================

export interface RawVideoResponse {
    video?: string;  // URL or base64
    url?: string;
    base64?: string;
    b64_json?: string;
    duration?: number;
    videos?: Array<{
        url?: string;
        base64?: string;
        duration?: number;
    }>;
}

/**
 * Adapt any provider's video response to OpenAI format
 */
export function adaptVideoResponse(
    raw: RawVideoResponse,
    model: string
): VideoGenerationResponse {
    const data: VideoData[] = [];

    if (raw.videos && raw.videos.length > 0) {
        for (const vid of raw.videos) {
            data.push({
                url: vid.url,
                b64_json: vid.base64,
                duration: vid.duration,
            });
        }
    } else if (raw.url || raw.video || raw.base64) {
        data.push({
            url: raw.url || (raw.video?.startsWith("http") ? raw.video : undefined),
            b64_json: raw.base64 || (raw.video && !raw.video.startsWith("http") ? raw.video : undefined),
            duration: raw.duration,
        });
    }

    return {
        id: generateVideoId(),
        created: Math.floor(Date.now() / 1000),
        data,
        model,
    };
}

// =============================================================================
// Error Adapters
// =============================================================================

/**
 * Map provider error to OpenAI error format
 */
export function adaptError(
    error: Error | unknown,
    statusCode: number = 500
): { status: number; body: OpenAIError } {
    const message = error instanceof Error ? error.message : String(error);

    // Map common error patterns
    let type = "internal_error";
    let code: string | null = null;

    if (statusCode === 400 || message.toLowerCase().includes("invalid")) {
        type = "invalid_request_error";
    } else if (statusCode === 401 || message.toLowerCase().includes("auth") || message.toLowerCase().includes("key")) {
        type = "authentication_error";
        code = "invalid_api_key";
    } else if (statusCode === 403) {
        type = "permission_error";
    } else if (statusCode === 404 || message.toLowerCase().includes("not found")) {
        type = "invalid_request_error";
        code = "model_not_found";
    } else if (statusCode === 429 || message.toLowerCase().includes("rate") || message.toLowerCase().includes("limit")) {
        type = "rate_limit_error";
        code = "rate_limit_exceeded";
    } else if (message.toLowerCase().includes("context") || message.toLowerCase().includes("token")) {
        type = "invalid_request_error";
        code = "context_length_exceeded";
    }

    return {
        status: statusCode,
        body: {
            error: {
                message,
                type,
                param: null,
                code,
            },
        },
    };
}
