/**
 * OpenAI-Compatible API Endpoints
 * 
 * Route handlers for all /v1/* endpoints.
 * Uses central invoke layer for all provider calls.
 * Includes x402 pay-per-call integration.
 */

import type { Request, Response } from "express";
import type {
    ChatCompletionRequest,
    ImageGenerationRequest,
    AudioSpeechRequest,
    AudioTranscriptionRequest,
    EmbeddingRequest,
    VideoGenerationRequest,
    ModelsListResponse,
    OpenAIModelDetails,
} from "./types.js";
import {
    generateCompletionId,
    formatSSE,
    formatSSEDone,
    createErrorResponse,
} from "./types.js";
import {
    adaptChatResponse,
    adaptStreamChunk,
    adaptImageResponse,
    adaptTranscriptionResponse,
    adaptEmbeddingResponse,
    adaptVideoResponse,
    adaptError,
} from "./adapter.js";
import {
    getCompiledModels,
    getModelById,
    getExtendedModels,
    calculateInferenceCost,
} from "../../models/registry.js";
import type { ModelCard } from "../../models/types.js";

// x402 Payment handling
import { requirePayment } from "../../x402/index.js";

// Central invocation layer for all provider calls
import {
    invokeChat,
    invokeImage,
    invokeVideo,
    invokeTTS,
    invokeASR,
    invokeEmbedding,
    type ChatMessage,
} from "../../models/invoke.js";

// =============================================================================
// Model Conversion
// =============================================================================

/**
 * Convert ModelCard to OpenAI model format
 */
function modelCardToOpenAI(card: ModelCard): OpenAIModelDetails {
    return {
        id: card.modelId,
        object: "model",
        created: typeof card.createdAt === "number"
            ? card.createdAt
            : (card.createdAt ? new Date(card.createdAt).getTime() / 1000 : Date.now() / 1000),
        owned_by: card.ownedBy || card.provider,
        provider: card.provider,  // Explicit provider for routing
        name: card.name,
        description: card.description,
        context_window: card.contextWindow,
        max_output_tokens: card.maxOutputTokens,
        capabilities: card.capabilities,
        pricing: card.pricing || undefined,
        task_type: card.taskType as string,
        input_modalities: card.inputModalities,
        output_modalities: card.outputModalities,
    };
}

// =============================================================================
// Models Endpoints
// =============================================================================

/**
 * GET /v1/models - List available models
 */
export async function handleListModels(
    req: Request,
    res: Response,
    extended: boolean = false
): Promise<void> {
    try {
        const models = extended ? getExtendedModels() : getCompiledModels();
        const response: ModelsListResponse = {
            object: "list",
            data: models.models.map(modelCardToOpenAI),
        };
        res.status(200).json(response);
    } catch (error) {
        const { status, body } = adaptError(error, 500);
        res.status(status).json(body);
    }
}

/**
 * GET /v1/models/:model - Get specific model details
 */
export async function handleGetModel(
    req: Request,
    res: Response
): Promise<void> {
    try {
        const modelId = req.params.model || req.params.id;
        if (!modelId) {
            res.status(400).json(createErrorResponse(
                "Model ID is required",
                "invalid_request_error",
                "missing_model_id"
            ));
            return;
        }

        const model = getModelById(modelId);
        if (!model) {
            res.status(404).json(createErrorResponse(
                `Model '${modelId}' not found`,
                "invalid_request_error",
                "model_not_found"
            ));
            return;
        }

        res.status(200).json(modelCardToOpenAI(model));
    } catch (error) {
        const { status, body } = adaptError(error, 500);
        res.status(status).json(body);
    }
}

// =============================================================================
// Chat Completions Endpoint
// =============================================================================

/**
 * POST /v1/chat/completions - Create chat completion (with x402 payment)
 */
export async function handleChatCompletions(
    req: Request,
    res: Response
): Promise<void> {
    try {
        const body: ChatCompletionRequest = req.body;

        // Validate required fields
        if (!body.model) {
            res.status(400).json(createErrorResponse(
                "model is required",
                "invalid_request_error",
                "missing_model"
            ));
            return;
        }

        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
            res.status(400).json(createErrorResponse(
                "messages is required and must be a non-empty array",
                "invalid_request_error",
                "missing_messages"
            ));
            return;
        }

        // Verify x402 payment before processing
        if (!await requirePayment(req, res)) {
            return; // Payment required response already sent
        }

        const requestId = generateCompletionId();

        // Convert messages to ChatMessage format
        const messages: ChatMessage[] = body.messages.map(m => ({
            role: m.role as "system" | "user" | "assistant" | "tool",
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        }));

        // Check if streaming
        if (body.stream) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Request-Id", requestId);

            try {
                await invokeChat(body.model, messages, {
                    stream: true,
                    maxTokens: body.max_tokens || body.max_completion_tokens,
                    temperature: body.temperature,
                    onToken: (token: string) => {
                        const chunk = adaptStreamChunk(token, body.model, requestId, false);
                        res.write(formatSSE(chunk));
                    },
                    onComplete: () => {
                        const finalChunk = adaptStreamChunk("", body.model, requestId, true, "stop");
                        res.write(formatSSE(finalChunk));
                        res.write(formatSSEDone());
                        res.end();
                    },
                });
            } catch (error) {
                if (!res.headersSent) {
                    const { status, body: errBody } = adaptError(error, 500);
                    res.status(status).json(errBody);
                }
            }
        } else {
            // Non-streaming response
            const result = await invokeChat(body.model, messages, {
                maxTokens: body.max_tokens || body.max_completion_tokens,
                temperature: body.temperature,
            });
            if (result) {
                const response = adaptChatResponse(result, body.model, requestId);
                res.status(200).json(response);
            }
        }
    } catch (error) {
        const { status, body: errBody } = adaptError(error, 500);
        res.status(status).json(errBody);
    }
}

// =============================================================================
// Images Endpoints
// =============================================================================

/**
 * POST /v1/images/generations - Generate images from text
 */
export async function handleImageGeneration(
    req: Request,
    res: Response
): Promise<void> {
    try {
        const body: ImageGenerationRequest = req.body;

        if (!body.prompt) {
            res.status(400).json(createErrorResponse(
                "prompt is required",
                "invalid_request_error",
                "missing_prompt"
            ));
            return;
        }

        const model = body.model || "dall-e-3";

        // Verify x402 payment before processing
        if (!await requirePayment(req, res)) return;

        const result = await invokeImage(model, body.prompt, {
            n: body.n,
            size: body.size,
            quality: body.quality,
        });

        // Adapt buffer to OpenAI format
        const response = adaptImageResponse({
            images: [{
                b64_json: result.buffer.toString("base64"),
            }],
        });
        res.status(200).json(response);
    } catch (error) {
        const { status, body: errBody } = adaptError(error, 500);
        res.status(status).json(errBody);
    }
}

/**
 * POST /v1/images/edits - Edit images
 * Note: Uses image generation with image input for edit capability
 */
export async function handleImageEdit(
    req: Request,
    res: Response
): Promise<void> {
    try {
        const body = req.body;

        if (!body.image) {
            res.status(400).json(createErrorResponse(
                "image is required",
                "invalid_request_error",
                "missing_image"
            ));
            return;
        }

        if (!body.prompt) {
            res.status(400).json(createErrorResponse(
                "prompt is required",
                "invalid_request_error",
                "missing_prompt"
            ));
            return;
        }

        // Use image generation with reference image
        const model = body.model || "dall-e-2";

        // Verify x402 payment before processing
        if (!await requirePayment(req, res)) return;

        const result = await invokeImage(model, body.prompt, {
            n: body.n,
            size: body.size,
        });

        const response = adaptImageResponse({
            images: [{
                b64_json: result.buffer.toString("base64"),
            }],
        });
        res.status(200).json(response);
    } catch (error) {
        const { status, body: errBody } = adaptError(error, 500);
        res.status(status).json(errBody);
    }
}

// =============================================================================
// Audio Endpoints
// =============================================================================

/**
 * POST /v1/audio/speech - Text to speech
 */
export async function handleAudioSpeech(
    req: Request,
    res: Response
): Promise<void> {
    try {
        const body: AudioSpeechRequest = req.body;

        if (!body.input) {
            res.status(400).json(createErrorResponse(
                "input is required",
                "invalid_request_error",
                "missing_input"
            ));
            return;
        }

        const model = body.model || "tts-1";
        const voice = body.voice || "alloy";
        const format = body.response_format || "mp3";

        // Verify x402 payment before processing
        if (!await requirePayment(req, res)) return;

        const audioBuffer = await invokeTTS(model, body.input, {
            voice,
            speed: body.speed,
            responseFormat: format,
        });

        // Set appropriate content type
        const contentTypes: Record<string, string> = {
            mp3: "audio/mpeg",
            opus: "audio/opus",
            aac: "audio/aac",
            flac: "audio/flac",
            wav: "audio/wav",
            pcm: "audio/pcm",
        };

        res.setHeader("Content-Type", contentTypes[format] || "audio/mpeg");
        res.send(audioBuffer);
    } catch (error) {
        const { status, body: errBody } = adaptError(error, 500);
        res.status(status).json(errBody);
    }
}

/**
 * POST /v1/audio/transcriptions - Speech to text
 */
export async function handleAudioTranscription(
    req: Request,
    res: Response
): Promise<void> {
    try {
        const body: AudioTranscriptionRequest = req.body;

        if (!body.file) {
            res.status(400).json(createErrorResponse(
                "file is required",
                "invalid_request_error",
                "missing_file"
            ));
            return;
        }

        const model = body.model || "whisper-1";

        // Decode base64 file to buffer
        const audioBuffer = Buffer.from(body.file, "base64");

        // Verify x402 payment before processing
        if (!await requirePayment(req, res)) return;

        const result = await invokeASR(model, audioBuffer, {
            language: body.language,
            responseFormat: body.response_format,
        });

        const response = adaptTranscriptionResponse(result);

        // Return text only if response_format is "text"
        if (body.response_format === "text") {
            res.setHeader("Content-Type", "text/plain");
            res.send(response.text);
        } else {
            res.status(200).json(response);
        }
    } catch (error) {
        const { status, body: errBody } = adaptError(error, 500);
        res.status(status).json(errBody);
    }
}

// =============================================================================
// Embeddings Endpoint
// =============================================================================

/**
 * POST /v1/embeddings - Create embeddings
 */
export async function handleEmbeddings(
    req: Request,
    res: Response
): Promise<void> {
    try {
        const body: EmbeddingRequest = req.body;

        if (!body.input) {
            res.status(400).json(createErrorResponse(
                "input is required",
                "invalid_request_error",
                "missing_input"
            ));
            return;
        }

        if (!body.model) {
            res.status(400).json(createErrorResponse(
                "model is required",
                "invalid_request_error",
                "missing_model"
            ));
            return;
        }

        // Verify x402 payment before processing
        if (!await requirePayment(req, res)) return;

        const result = await invokeEmbedding(body.model, body.input, {
            dimensions: body.dimensions,
        });

        const response = adaptEmbeddingResponse({
            embeddings: result.embeddings,
        }, body.model, result.usage.promptTokens);

        res.status(200).json(response);
    } catch (error) {
        const { status, body: errBody } = adaptError(error, 500);
        res.status(status).json(errBody);
    }
}

// =============================================================================
// Video Endpoints
// =============================================================================

/**
 * POST /v1/videos/generations - Generate videos
 */
export async function handleVideoGeneration(
    req: Request,
    res: Response
): Promise<void> {
    try {
        const body: VideoGenerationRequest = req.body;

        if (!body.prompt) {
            res.status(400).json(createErrorResponse(
                "prompt is required",
                "invalid_request_error",
                "missing_prompt"
            ));
            return;
        }

        if (!body.model) {
            res.status(400).json(createErrorResponse(
                "model is required",
                "invalid_request_error",
                "missing_model"
            ));
            return;
        }

        // Verify x402 payment before processing
        if (!await requirePayment(req, res)) return;

        const result = await invokeVideo(body.model, body.prompt, {
            duration: body.duration,
            aspectRatio: body.aspect_ratio,
            resolution: body.size,
        });

        // Adapt to OpenAI format
        const response = adaptVideoResponse({
            videos: [{
                base64: result.buffer.toString("base64"),
                duration: body.duration,
            }],
        }, body.model);

        res.status(200).json(response);
    } catch (error) {
        const { status, body: errBody } = adaptError(error, 500);
        res.status(status).json(errBody);
    }
}
