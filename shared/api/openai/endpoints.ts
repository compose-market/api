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
    submitVideoJob,
    checkVideoJobStatus,
    type ChatMessage,
    type VideoJobResult,
    type VideoJobStatus,
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

        console.log(`[chat] Received request for model: "${body.model}"`);

        // Lookup model to verify it exists and log provider
        const modelCard = getModelById(body.model);
        console.log(`[chat] Model lookup result: ${modelCard ? `found (provider: ${modelCard.provider})` : "NOT FOUND"}`);
        if (!modelCard) {
            console.error(`[chat] Available model IDs (first 10):`);
            const compiled = getCompiledModels();
            compiled.models.slice(0, 10).forEach(m => console.error(`  - ${m.modelId}`));
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

        // Check for image/audio attachment URLs
        const imageUrl = (body as any).image_url;
        const audioUrl = (body as any).audio_url;

        // Convert messages to ChatMessage format - preserve all fields
        // For vision/audio models, inject image_url or audio_url into the last user message
        const messages: ChatMessage[] = body.messages.map((m, idx) => {
            const isLastUserMessage = m.role === "user" && idx === body.messages.length - 1;

            // If this is the last user message and we have media attachments, use multipart content
            if (isLastUserMessage && (imageUrl || audioUrl)) {
                const contentParts: any[] = [
                    { type: "text" as const, text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) },
                ];

                if (imageUrl) {
                    console.log(`[chat] Injecting image_url into last user message: ${imageUrl.slice(0, 60)}...`);
                    contentParts.push({ type: "image_url" as const, image_url: { url: imageUrl } });
                }
                if (audioUrl) {
                    console.log(`[chat] Injecting audio_url into last user message: ${audioUrl.slice(0, 60)}...`);
                    // Use input_audio format for audio attachments (per OpenAI Realtime/GPT-4o-audio format)
                    contentParts.push({ type: "input_audio" as const, input_audio: { url: audioUrl } });
                }

                return {
                    role: m.role as "system" | "user" | "assistant" | "tool",
                    content: contentParts,
                    tool_calls: m.tool_calls,
                    tool_call_id: m.tool_call_id,
                    name: m.name,
                };
            }

            return {
                role: m.role as "system" | "user" | "assistant" | "tool",
                content: typeof m.content === "string" ? m.content : (m.content ? JSON.stringify(m.content) : null),
                // Preserve tool-related fields
                tool_calls: m.tool_calls,
                tool_call_id: m.tool_call_id,
                name: m.name,
            };
        });

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
                    tools: body.tools,
                    tool_choice: body.tool_choice,
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
                tools: body.tools,
                tool_choice: body.tool_choice,
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

        // Support image_url for image-to-image workflows (from frontend IPFS attachments)
        const imageUrl = (body as any).image_url || (body as any).image;

        const result = await invokeImage(model, body.prompt, {
            n: body.n,
            size: body.size,
            quality: body.quality,
            imageUrl: imageUrl,  // Pass URL for image-to-image
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
 * Returns job ID immediately for async providers (AIML, etc.)
 * Returns video directly for sync providers
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

        // Check if this model uses async video generation
        const modelCard = getModelById(body.model);
        const asyncProviders = ["aiml", "openai", "google", "huggingface", "openrouter"];
        const isAsyncProvider = asyncProviders.includes(modelCard?.provider || "");

        if (isAsyncProvider) {
            // Async path: submit job and return ID immediately
            console.log(`[video] Using async generation for ${body.model} (provider: ${modelCard?.provider})`);
            const jobResult = await submitVideoJob(body.model, body.prompt, {
                duration: body.duration,
                aspectRatio: body.aspect_ratio,
                imageUrl: body.image_url || body.image,  // Support both URL and base64
            });

            // Return OpenAI-style async response
            res.status(202).json({
                id: jobResult.jobId,
                object: "video.generation",
                status: jobResult.status,
                created: Math.floor(Date.now() / 1000),
                model: body.model,
            });
            return;
        }

        // Sync path: wait for video and return directly
        const result = await invokeVideo(body.model, body.prompt, {
            duration: body.duration,
            aspectRatio: body.aspect_ratio,
            resolution: body.size,
            imageUrl: body.image_url || body.image,  // Support both URL and base64
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

/**
 * GET /v1/videos/:id - Check video generation status
 * Polls the provider and returns current status
 */
export async function handleVideoStatus(
    req: Request,
    res: Response
): Promise<void> {
    try {
        const jobId = req.params.id;
        if (!jobId) {
            res.status(400).json(createErrorResponse(
                "Video job ID is required",
                "invalid_request_error",
                "missing_job_id"
            ));
            return;
        }

        const status = await checkVideoJobStatus(jobId);

        res.status(200).json({
            id: status.jobId,
            object: "video.generation",
            status: status.status,
            url: status.url,
            error: status.error,
            progress: status.progress,
        });
    } catch (error) {
        const { status, body: errBody } = adaptError(error, 500);
        res.status(status).json(errBody);
    }
}
