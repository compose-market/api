/**
 * OpenAI-Compatible API Endpoints - Enterprise Grade
 * 
 * Unified handler for ALL model invocations with:
 * - x402 payment integration (deferred settlement)
 * - Response adapters for OpenAI compatibility
 * - Proper SSE formatting and streaming
 * - Response validation
 * - Error handling with proper formatting
 * - CORS handling for cross-origin requests
 * - Async video generation support
 */

import type { Request, Response } from "express";
import { getCompiledModels, getModelById, getExtendedModels } from "../../models/registry.js";
import type { ModelCard } from "../../models/types.js";
import { requirePayment, preparePayment, handleX402Payment, INFERENCE_PRICE_WEI } from "../../x402/index.js";
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
} from "../../models/invoke.js";

import {
    adaptChatResponse,
    adaptStreamChunk,
    adaptStreamToolCallChunk,
    adaptImageResponse,
    adaptTranscriptionResponse,
    adaptEmbeddingResponse,
    adaptVideoResponse,
    adaptError,
} from "./adapter.js";

import {
    generateCompletionId,
    formatSSE,
    formatSSEDone,
    createErrorResponse,
    type ChatCompletionRequest,
    type ImageGenerationRequest,
    type AudioSpeechRequest,
    type AudioTranscriptionRequest,
    type EmbeddingRequest,
    type VideoGenerationRequest,
    type ModelsListResponse,
    type OpenAIModelDetails,
} from "./types.js";

// =============================================================================
// CORS Headers
// =============================================================================

/**
 * Set CORS headers for all responses
 * Required for browser-based clients accessing the API
 * CRITICAL: This is used by backend/manowar which does NOT go through handler.ts
 */
function setCorsHeaders(res: Response): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Chain-Id, X-Payment-Data");
    res.setHeader("Access-Control-Expose-Headers", "X-Transaction-Hash, X-Request-Id");
}

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
        provider: card.provider,
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
        setCorsHeaders(res);
        
        // Handle preflight
        if (req.method === "OPTIONS") {
            res.status(200).end();
            return;
        }
        
        const models = extended ? getExtendedModels() : getCompiledModels();
        const response: ModelsListResponse = {
            object: "list",
            data: models.models.map(modelCardToOpenAI),
        };
        res.status(200).json(response);
    } catch (error) {
        setCorsHeaders(res);
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
        setCorsHeaders(res);
        
        if (req.method === "OPTIONS") {
            res.status(200).end();
            return;
        }
        
        const modelIdParam = req.params.model || req.params.id;
        const modelId = Array.isArray(modelIdParam) ? modelIdParam[0] : modelIdParam;
        
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
        setCorsHeaders(res);
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
    // Set CORS headers immediately
    setCorsHeaders(res);
    
    // Handle preflight
    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }
    
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

        // Lookup model to verify it exists
        const modelCard = getModelById(body.model);
        console.log(`[chat] Model lookup result: ${modelCard ? `found (provider: ${modelCard.provider})` : "NOT FOUND"}`);
        
        if (!modelCard) {
            console.error(`[chat] Available model IDs (first 10):`);
            const compiled = getCompiledModels();
            compiled.models.slice(0, 10).forEach(m => console.error(`  - ${m.modelId}`));
            
            res.status(404).json(createErrorResponse(
                `Model '${body.model}' not found`,
                "invalid_request_error",
                "model_not_found"
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

        // Prepare payment (validate without charging yet)
        const payment = await preparePayment(req);
        if (!payment.valid) {
            const resourceUrl = `https://${req.get?.("host") || "api.compose.market"}${req.originalUrl || req.url}`;
            const chainIdHeader = req.get?.("x-chain-id") || req.headers?.["x-chain-id"];
            const explicitChainId = chainIdHeader ? parseInt(String(chainIdHeader)) : undefined;

            const x402Result = await handleX402Payment(
                null,
                resourceUrl,
                req.method || "POST",
                String(INFERENCE_PRICE_WEI),
                explicitChainId,
            );
            
            setCorsHeaders(res);
            Object.entries(x402Result.responseHeaders).forEach(([key, value]) => {
                res.setHeader(key, value);
            });
            res.status(x402Result.status).json(x402Result.responseBody);
            return;
        }

        const requestId = generateCompletionId();

        // Check for image/audio attachment URLs
        const imageUrl = (body as any).image_url;
        const audioUrl = (body as any).audio_url;

        // Convert messages to ChatMessage format
        const messages: ChatMessage[] = body.messages.map((m, idx) => {
            const isLastUserMessage = m.role === "user" && idx === body.messages.length - 1;

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
                tool_calls: m.tool_calls,
                tool_call_id: m.tool_call_id,
                name: m.name,
            };
        });

        // Check if streaming
        if (body.stream) {
            // Set SSE headers
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Request-Id", requestId);

            console.log(`[chat] Streaming request: model=${body.model}, messages=${messages.length}, tools=${body.tools?.length || 0}`);

            let paymentSettled = false;
            let hasToolCalls = false;
            let fullContent = "";

            try {
                await invokeChat(body.model, messages, {
                    stream: true,
                    maxTokens: body.max_tokens || body.max_completion_tokens,
                    temperature: body.temperature,
                    tools: body.tools,
                    tool_choice: body.tool_choice,
                    onToken: async (token: string) => {
                        const isFirst = !paymentSettled;

                        // Settle payment on FIRST token
                        if (!paymentSettled) {
                            paymentSettled = true;
                            console.log(`[chat] First token received, settling payment...`);
                            const settled = await payment.settle();
                            if (settled.txHash) {
                                console.log(`[chat] Payment settled: ${settled.txHash}`);
                                try {
                                    res.setHeader("X-Transaction-Hash", settled.txHash);
                                } catch {
                                    console.log(`[chat] Payment settled (tx: ${settled.txHash}) but headers already sent`);
                                }
                            }
                        }

                        fullContent += token;
                        
                        // Use adapter for proper SSE formatting
                        const chunk = adaptStreamChunk(token, body.model, requestId, false, null, isFirst);
                        const sseData = formatSSE(chunk);
                        console.log(`[chat] Sending SSE chunk: ${sseData.slice(0, 100)}${sseData.length > 100 ? '...' : ''}`);
                        res.write(sseData);
                    },
                    onToolCall: async (toolCall) => {
                        hasToolCalls = true;

                        if (!paymentSettled) {
                            paymentSettled = true;
                            console.log(`[chat] First tool call received, settling payment...`);
                            const settled = await payment.settle();
                            if (settled.txHash) {
                                console.log(`[chat] Payment settled: ${settled.txHash}`);
                                try {
                                    res.setHeader("X-Transaction-Hash", settled.txHash);
                                } catch {
                                    console.log(`[chat] Payment settled (tx: ${settled.txHash}) but headers already sent`);
                                }
                            }
                        }

                        // Format tool call using adapter
                        const chunk = adaptStreamToolCallChunk(toolCall, body.model, requestId);
                        console.log(`[chat] Tool call SSE chunk: ${JSON.stringify(chunk)}`);
                        res.write(formatSSE(chunk));
                    },
                    onComplete: () => {
                        const finishReason = hasToolCalls ? "tool_calls" : "stop";
                        console.log(`[chat] Stream complete. Total content length: ${fullContent.length} chars, finish_reason: ${finishReason}`);
                        
                        const finalChunk = adaptStreamChunk("", body.model, requestId, true, finishReason);
                        res.write(formatSSE(finalChunk));
                        res.write(formatSSEDone());
                        res.end();
                    },
                    onError: (error) => {
                        console.error(`[chat] Stream error from invokeChat: ${error.message}`);
                        // Error will be handled by the catch block below
                        throw error;
                    },
                });
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Unknown streaming error";
                console.error(`[chat] Streaming error: ${errorMessage}`);

                const errorChunk = {
                    id: requestId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: "error" as const,
                    }],
                    error: {
                        message: errorMessage,
                        type: "streaming_error",
                    },
                };

                try {
                    res.write(formatSSE(errorChunk));
                    res.write(formatSSEDone());
                    res.end();
                } catch (writeError) {
                    console.error(`[chat] Could not send error to client:`, writeError);
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
            
            if (!result) {
                res.status(500).json(createErrorResponse("Empty response from model", "internal_error"));
                return;
            }

            console.log(`[chat] Non-streaming response ready, settling payment...`);
            const settled = await payment.settle();
            if (settled.txHash) {
                res.setHeader("x-compose-key-tx-hash", settled.txHash);
            }

            const response = adaptChatResponse(result, body.model, requestId);
            res.status(200).json(response);
        }
    } catch (error) {
        setCorsHeaders(res);
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
    setCorsHeaders(res);
    
    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }
    
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

        if (!await requirePayment(req, res)) return;

        const imageUrl = (body as any).image_url || (body as any).image;

        const result = await invokeImage(model, body.prompt, {
            n: body.n,
            size: body.size,
            quality: body.quality,
            imageUrl: imageUrl,
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

/**
 * POST /v1/images/edits - Edit images
 */
export async function handleImageEdit(
    req: Request,
    res: Response
): Promise<void> {
    setCorsHeaders(res);
    
    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }
    
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

        const model = body.model || "dall-e-2";

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
    setCorsHeaders(res);
    
    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }
    
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

        if (!await requirePayment(req, res)) return;

        const audioBuffer = await invokeTTS(model, body.input, {
            voice,
            speed: body.speed,
            responseFormat: format,
        });

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
    setCorsHeaders(res);
    
    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }
    
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
        const audioBuffer = Buffer.from(body.file, "base64");

        if (!await requirePayment(req, res)) return;

        const result = await invokeASR(model, audioBuffer, {
            language: body.language,
            responseFormat: body.response_format,
        });

        const response = adaptTranscriptionResponse(result);

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
    setCorsHeaders(res);
    
    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }
    
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
 * Returns job ID immediately for async providers (AIML, OpenAI, Google)
 * Returns video directly for sync providers
 */
export async function handleVideoGeneration(
    req: Request,
    res: Response
): Promise<void> {
    setCorsHeaders(res);
    
    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }
    
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
                imageUrl: body.image_url || body.image,
            });

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
            imageUrl: body.image_url || body.image,
        });

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
    setCorsHeaders(res);
    
    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }
    
    try {
        const jobIdParam = req.params.id;
        const jobId = Array.isArray(jobIdParam) ? jobIdParam[0] : jobIdParam;
        
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
