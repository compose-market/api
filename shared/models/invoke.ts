/**
 * Unified Model Invocation - Enterprise Grade
 * 
 * Single function handles ALL providers and modalities using AI SDK.
 * Routes to provider's native API via AI SDK, returns normalized response.
 * Production-grade error handling, streaming, and multimodal support.
 * 
 * Architecture:
 * - AI SDK for unified interface (streamText, generateText, embedMany)
 * - Provider-specific modules for non-chat modalities (image, video, audio)
 * - Direct HTTP fallback for tool conversations (bypasses AI SDK transforms)
 * 
 * Features:
 * - Timeout handling (30s between chunks)
 * - Proper error logging (no silent failures)
 * - Response validation and normalization
 * - Token usage tracking
 * - Full multimodal support (chat, image, video, audio, embeddings)
 */

import { getModelById, getLanguageModel } from "./registry.js";
import type { ModelCard, ModelProvider } from "./types.js";

// AI SDK imports
import { streamText, generateText, embedMany } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";

// Provider-specific imports for non-chat modalities
import {
    generateImage as googleGenerateImage,
    generateVideo as googleGenerateVideo,
    generateSpeech as googleGenerateSpeech,
} from "./providers/genai.js";

import {
    openaiGenerateImage,
    openaiGenerateVideo,
    openaiGenerateSpeech,
    openaiTranscribeAudio,
} from "./providers/openai.js";

import {
    executeHFInference,
    type HFInferenceInput,
} from "./providers/huggingface.js";

// Vertex AI imports for all multimodal capabilities
import {
    generateVertexImage,
    generateVertexVideo,
    generateVertexSpeech,
    transcribeVertexAudio,
    generateVertexEmbeddings,
} from "./providers/vertex.js";

// Google GenAI SDK for video generation
import { GoogleGenAI } from "@google/genai";
import { jsonSchema } from "ai";

// =============================================================================
// Types
// =============================================================================

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null | Array<{
        type: "text" | "image_url" | "input_audio" | "video_url";
        text?: string;
        image_url?: { url: string };
        input_audio?: { url: string };
        video_url?: { url: string };
    }>;
    tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
    name?: string;
}

export interface ChatOptions {
    stream?: boolean;
    maxTokens?: number;
    temperature?: number;
    tools?: Array<{
        type: "function";
        function: {
            name: string;
            description?: string;
            parameters?: Record<string, unknown>;
        };
    }>;
    tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
    onToken?: (token: string) => void | Promise<void>;
    onToolCall?: (toolCall: { id: string; name: string; arguments: string }) => void | Promise<void>;
    onComplete?: (result: { usage: TokenUsage }) => void;
    onError?: (error: Error) => void | Promise<void>;
}

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface ChatResult {
    content: string;
    usage: TokenUsage;
    finishReason?: string;
    toolCalls?: Array<{
        id?: string;
        name: string;
        arguments: string | object;
    }>;
}

export interface ImageOptions {
    size?: string;
    quality?: string;
    n?: number;
    imageUrl?: string;
}

export interface ImageResult {
    buffer: Buffer;
    mimeType: string;
}

export interface VideoOptions {
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
    imageUrl?: string;
}

export interface VideoResult {
    buffer: Buffer;
    mimeType: string;
}

export interface VideoJobResult {
    jobId: string;
    status: "queued" | "processing";
}

export interface VideoJobStatus {
    jobId: string;
    status: "queued" | "processing" | "completed" | "failed";
    url?: string;
    error?: string;
    progress?: number;
}

export interface TTSOptions {
    voice?: string;
    speed?: number;
    responseFormat?: string;
}

export interface ASROptions {
    language?: string;
    responseFormat?: string;
}

export interface ASRResult {
    text: string;
    language?: string;
    duration?: number;
}

export interface EmbeddingOptions {
    dimensions?: number;
}

export interface EmbeddingResult {
    embeddings: number[][];
    usage: { promptTokens: number; totalTokens: number };
}

// =============================================================================
// Configuration
// =============================================================================

const STREAM_CHUNK_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Provider configuration for direct HTTP fallback (tool conversations)
interface ProviderStreamConfig {
    endpoint: string;
    apiKey: string;
    headers?: Record<string, string>;
}

const PROVIDER_CONFIG: Record<string, ProviderStreamConfig> = {
    openai: {
        endpoint: "https://api.openai.com/v1/chat/completions",
        apiKey: process.env.OPENAI_API_KEY || "",
    },
    anthropic: {
        endpoint: "https://api.anthropic.com/v1/messages",
        apiKey: process.env.ANTHROPIC_API_KEY || "",
        headers: { "anthropic-version": "2023-06-01" },
    },
    openrouter: {
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        apiKey: process.env.OPEN_ROUTER_API_KEY || "",
        headers: { "HTTP-Referer": "https://compose.market" },
    },
    huggingface: {
        endpoint: "https://router.huggingface.co/v1/chat/completions",
        apiKey: process.env.HUGGING_FACE_INFERENCE_TOKEN || "",
    },
    aiml: {
        endpoint: "https://api.aimlapi.com/v1/chat/completions",
        apiKey: process.env.AI_ML_API_KEY || "",
    },
    "asi-one": {
        endpoint: "https://api.asi1.ai/v1/chat/completions",
        apiKey: process.env.ASI_ONE_API_KEY || "",
    },
    "asi-cloud": {
        endpoint: "https://inference.asicloud.cudos.org/v1/chat/completions",
        apiKey: process.env.ASI_INFERENCE_API_KEY || "",
    },
};

// =============================================================================
// Helpers
// =============================================================================

function getProvider(modelId: string): { provider: ModelProvider; card: ModelCard | null } {
    const card = getModelById(modelId);
    if (!card) {
        console.error(`[invoke] Model not found in registry: ${modelId}`);
        throw new Error(`Model not found: ${modelId}. Ensure model is in the compiled registry.`);
    }
    return { provider: card.provider, card };
}

async function withRetry<T>(operation: () => Promise<T>, retries = MAX_RETRIES, delay = RETRY_DELAY_MS): Promise<T> {
    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.warn(`[invoke] Attempt ${attempt}/${retries} failed: ${lastError.message}`);
            
            if (attempt < retries) {
                const backoffDelay = delay * Math.pow(2, attempt - 1);
                console.log(`[invoke] Retrying in ${backoffDelay}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
            }
        }
    }
    
    throw lastError || new Error("Operation failed after max retries");
}

/**
 * Detect if this is a tool-using conversation that needs direct streaming.
 * AI SDK's @ai-sdk/openai-compatible can't handle tool message transformations.
 */
function isToolConversation(messages: ChatMessage[]): boolean {
    return messages.some(m =>
        (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) ||
        m.role === "tool"
    );
}

function getProviderStreamConfig(provider: ModelProvider): ProviderStreamConfig | null {
    return PROVIDER_CONFIG[provider] || null;
}

/**
 * Convert OpenAI-format tools to AI SDK format
 */
function convertToolsForAISDK(tools: ChatOptions["tools"]) {
    if (!tools || tools.length === 0) return undefined;

    const converted: Record<string, { description?: string; inputSchema: ReturnType<typeof jsonSchema> }> = {};

    for (const t of tools) {
        if (t.type === "function" && t.function) {
            converted[t.function.name] = {
                description: t.function.description || "",
                inputSchema: jsonSchema(t.function.parameters || { type: "object", properties: {} }),
            };
        }
    }

    return Object.keys(converted).length > 0 ? converted : undefined;
}

/**
 * Convert OpenAI tool_choice to AI SDK toolChoice format
 */
function convertToolChoice(toolChoice: ChatOptions["tool_choice"]): "auto" | "none" | "required" | { type: "tool"; toolName: string } | undefined {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === "string") {
        return toolChoice as "auto" | "none" | "required";
    }
    if (toolChoice.type === "function" && toolChoice.function) {
        return { type: "tool", toolName: toolChoice.function.name };
    }
    return undefined;
}

// Helper: Normalize content to string
const normalizeContentToString = (content: any): string => {
    if (content === null || content === undefined) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((p: any) => p?.type === "text" && p?.text)
            .map((p: any) => p.text)
            .join("\n") || JSON.stringify(content);
    }
    return String(content);
};

// Helper: Convert array content to AI SDK format parts
const normalizeContentParts = (contentArray: any[]): any[] => {
    const parts: any[] = [];
    for (const part of contentArray) {
        if (!part || typeof part !== "object") continue;

        if (part.type === "text" && part.text) {
            parts.push({ type: "text", text: part.text });
        } else if (part.type === "image_url") {
            const url = part.image_url?.url || part.image_url;
            if (url) parts.push({ type: "image", image: url });
        } else if (part.type === "input_audio") {
            const url = part.input_audio?.url || part.input_audio;
            if (url) parts.push({ type: "file", data: url, mimeType: "audio/mpeg" });
        } else if (part.type === "video_url") {
            const url = part.video_url?.url || part.video_url;
            if (url) parts.push({ type: "file", data: url, mimeType: "video/mp4" });
        } else if (part.type === "tool-call" || part.type === "tool_call") {
            parts.push({
                type: "tool-call",
                toolCallId: part.toolCallId || part.id || "",
                toolName: part.toolName || part.name || "",
                args: part.args || part.input || {},
            });
        } else if (part.type === "tool-result" || part.type === "tool_result") {
            parts.push({
                type: "tool-result",
                toolCallId: part.toolCallId || "",
                toolName: part.toolName || "",
                result: typeof part.result === "string" ? part.result : JSON.stringify(part.result || ""),
            });
        } else if (part.type === "tool-approval-response" || part.type === "tool_approval_response") {
            console.log(`[invokeChat] Converting tool-approval-response to tool-result`);
            parts.push({
                type: "tool-result",
                toolCallId: part.toolCallId || part.approvalId || "",
                toolName: part.toolName || "approved_tool",
                result: part.result || (part.approved ? "Tool approved and executed" : "Tool rejected"),
            });
        }
    }
    return parts;
};

// =============================================================================
// Direct HTTP Streaming (Fallback for Tool Conversations)
// =============================================================================

async function streamDirectToProvider(
    modelId: string,
    provider: ModelProvider,
    messages: ChatMessage[],
    options: ChatOptions
): Promise<void> {
    const config = getProviderStreamConfig(provider);
    if (!config) {
        throw new Error(`Direct streaming not supported for provider: ${provider}`);
    }

    console.log(`[invokeChat] Direct streaming to ${provider}: ${config.endpoint}`);

    const openaiMessages = messages.map(m => {
        const msg: any = { role: m.role, content: m.content };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.name) msg.name = m.name;
        return msg;
    });

    const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            ...config.headers,
        },
        body: JSON.stringify({
            model: modelId,
            messages: openaiMessages,
            stream: true,
            ...(options.tools && { tools: options.tools }),
            ...(options.tool_choice && { tool_choice: options.tool_choice }),
            ...(options.maxTokens && { max_tokens: options.maxTokens }),
            ...(options.temperature !== undefined && { temperature: options.temperature }),
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`[invokeChat] Direct streaming error: ${response.status} - ${errorText}`);
        throw new Error(`Provider error: ${response.status} - ${errorText.slice(0, 200)}`);
    }

    if (!response.body) {
        throw new Error("No response body from provider");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentToolCall: { id: string; name: string; arguments: string } | null = null;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const data = line.slice(6).trim();
                if (data === "[DONE]") {
                    if (currentToolCall && options.onToolCall) {
                        await options.onToolCall(currentToolCall);
                    }
                    if (options.onComplete) {
                        options.onComplete({ usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
                    }
                    return;
                }

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta;
                    if (!delta) continue;

                    if (delta.content && options.onToken) {
                        await options.onToken(delta.content);
                    }

                    if (delta.tool_calls && delta.tool_calls.length > 0) {
                        const tc = delta.tool_calls[0];
                        if (tc.id) {
                            if (currentToolCall && options.onToolCall) {
                                await options.onToolCall(currentToolCall);
                            }
                            currentToolCall = {
                                id: tc.id,
                                name: tc.function?.name || "",
                                arguments: tc.function?.arguments || "",
                            };
                        } else if (currentToolCall) {
                            if (tc.function?.name) currentToolCall.name += tc.function.name;
                            if (tc.function?.arguments) currentToolCall.arguments += tc.function.arguments;
                        }
                    }

                    if (parsed.choices?.[0]?.finish_reason) {
                        if (currentToolCall && options.onToolCall) {
                            await options.onToolCall(currentToolCall);
                            currentToolCall = null;
                        }
                    }
                } catch (parseError) {
                    console.warn(`[invokeChat] Failed to parse SSE chunk: ${data.slice(0, 100)}`);
                }
            }
        }

        if (options.onComplete) {
            options.onComplete({ usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
        }
    } finally {
        reader.releaseLock();
    }
}

// =============================================================================
// Chat/Text Generation (Primary Entry Point)
// =============================================================================

export async function invokeChat(
    modelId: string,
    messages: ChatMessage[],
    options: ChatOptions = {}
): Promise<ChatResult | void> {
    console.log(`[invokeChat] Starting chat for modelId: "${modelId}"`);

    const { provider, card } = getProvider(modelId);
    console.log(`[invokeChat] Provider: ${provider}, modelId: ${modelId}`);

    // VERTEX AI: Use direct Vertex API (not AI SDK)
    if (provider === "vertex") {
        console.log(`[invokeChat] Using Vertex AI direct API for ${modelId}`);
        const { streamVertexChat, generateVertexChat } = await import("./providers/vertex.js");
        
        // Convert messages to simple format for Vertex
        const vertexMessages = messages.map(m => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        }));
        
        if (options.stream) {
            let fullContent = "";
            await streamVertexChat(modelId, vertexMessages, {
                temperature: options.temperature,
                maxTokens: options.maxTokens,
                onToken: async (token) => {
                    fullContent += token;
                    if (options.onToken) await options.onToken(token);
                },
                onComplete: async () => {
                    if (options.onComplete) {
                        options.onComplete({
                            usage: {
                                promptTokens: 0,
                                completionTokens: fullContent.length / 4,
                                totalTokens: fullContent.length / 4,
                            }
                        });
                    }
                },
                onError: options.onError,
            });
            return;
        } else {
            const text = await generateVertexChat(modelId, vertexMessages, {
                temperature: options.temperature,
                maxTokens: options.maxTokens,
            });
            return {
                content: text,
                usage: {
                    promptTokens: 0,
                    completionTokens: text.length / 4,
                    totalTokens: text.length / 4,
                },
                finishReason: "stop",
            };
        }
    }

    // FALLBACK: Use direct streaming for tool conversations
    if (options.stream && isToolConversation(messages)) {
        const config = getProviderStreamConfig(provider);
        if (config) {
            console.log(`[invokeChat] Tool conversation detected, using direct streaming to ${provider}`);
            return streamDirectToProvider(modelId, provider, messages, options);
        }
        console.log(`[invokeChat] Tool conversation detected but direct streaming not available for ${provider}, falling back to AI SDK`);
    }

    const modelInstance = getLanguageModel(modelId);
    console.log(`[invokeChat] Got model instance, modelId in instance: ${(modelInstance as any).modelId || "unknown"}`);

    // Convert messages to AI SDK format
    const mappedMessages = messages.map(m => {
        if (m.role === "system") {
            return { role: "system", content: normalizeContentToString(m.content) };
        }

        if (m.role === "user") {
            if (Array.isArray(m.content)) {
                const parts = normalizeContentParts(m.content);
                if (parts.length === 0) {
                    return { role: "user", content: normalizeContentToString(m.content) };
                }
                return { role: "user", content: parts };
            }
            return { role: "user", content: normalizeContentToString(m.content) };
        }

        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
            const content: any[] = [];
            const textContent = normalizeContentToString(m.content);
            if (textContent) {
                content.push({ type: "text", text: textContent });
            }

            for (const tc of m.tool_calls) {
                try {
                    content.push({
                        type: "tool-call",
                        toolCallId: tc.id || "",
                        toolName: tc.function?.name || "",
                        args: typeof tc.function?.arguments === "string"
                            ? JSON.parse(tc.function.arguments || "{}")
                            : (tc.function?.arguments || {}),
                    });
                } catch (e) {
                    console.warn(`[invokeChat] Failed to parse tool call arguments:`, e);
                    content.push({
                        type: "tool-call",
                        toolCallId: tc.id || "",
                        toolName: tc.function?.name || "",
                        args: {},
                    });
                }
            }

            return { role: "assistant", content };
        }

        if (m.role === "assistant") {
            if (Array.isArray(m.content)) {
                const parts = normalizeContentParts(m.content);
                if (parts.length === 0) {
                    const textContent = normalizeContentToString(m.content);
                    return { role: "assistant", content: textContent || "" };
                }
                return { role: "assistant", content: parts };
            }
            return { role: "assistant", content: normalizeContentToString(m.content) };
        }

        if (m.role === "tool") {
            return {
                role: "tool",
                content: [{
                    type: "tool-result",
                    toolCallId: m.tool_call_id || "",
                    toolName: m.name || "",
                    result: normalizeContentToString(m.content),
                }],
            };
        }

        console.warn(`[invokeChat] Unknown message role: ${m.role}, normalizing content`);
        return { role: m.role as any, content: normalizeContentToString(m.content) };
    });

    if (options.stream) {
        console.log(`[invokeChat] Starting streaming mode`);
        console.log(`[invokeChat] Messages count: ${mappedMessages.length}`);

        const result = streamText({
            model: modelInstance,
            messages: mappedMessages,
            ...(options.maxTokens && { maxTokens: options.maxTokens }),
            ...(options.temperature !== undefined && { temperature: options.temperature }),
            ...(options.tools && { tools: convertToolsForAISDK(options.tools) }),
            ...(options.tool_choice && { toolChoice: convertToolChoice(options.tool_choice) }),
            onError: (error) => {
                console.error(`[invokeChat] AI SDK stream error:`, error);
                if (options.onError) {
                    options.onError(error instanceof Error ? error : new Error(String(error)));
                }
            },
        });

        let chunkCount = 0;
        let lastChunkTime = Date.now();

        for await (const part of result.fullStream) {
            const timeSinceLastChunk = Date.now() - lastChunkTime;
            if (timeSinceLastChunk > STREAM_CHUNK_TIMEOUT_MS) {
                console.error(`[invokeChat] Stream timeout: ${timeSinceLastChunk}ms since last chunk`);
                throw new Error(`Stream timeout: no data received for ${Math.floor(timeSinceLastChunk / 1000)}s`);
            }
            lastChunkTime = Date.now();

            chunkCount++;

            if (part.type === "text-delta") {
                if (options.onToken) await options.onToken((part as any).text || "");
            } else if (part.type === "tool-call") {
                const toolCallData = {
                    id: (part as any).toolCallId || `call_${chunkCount}`,
                    name: (part as any).toolName || "",
                    arguments: JSON.stringify((part as any).input || (part as any).args || {}),
                };
                console.log(`[invokeChat] Tool call: ${toolCallData.name}`);
                if (options.onToolCall) {
                    await options.onToolCall(toolCallData);
                }
            } else if (part.type === "error") {
                console.error(`[invokeChat] Stream error:`, (part as any).error);
                throw new Error(`Stream error: ${(part as any).error}`);
            }
        }

        console.log(`[invokeChat] Streaming complete. Total chunks: ${chunkCount}`);

        const usage = await result.usage;
        if (options.onComplete) {
            options.onComplete({
                usage: {
                    promptTokens: (usage as any)?.promptTokens || 0,
                    completionTokens: (usage as any)?.completionTokens || 0,
                    totalTokens: (usage as any)?.totalTokens || 0,
                }
            });
        }
        return;
    }

    // Non-streaming mode
    const result = await generateText({
        model: modelInstance,
        messages: mappedMessages,
        ...(options.maxTokens && { maxTokens: options.maxTokens }),
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.tools && { tools: convertToolsForAISDK(options.tools) }),
        ...(options.tool_choice && { toolChoice: convertToolChoice(options.tool_choice) }),
    });

    const toolCalls = result.toolCalls?.map((tc: any, i: number) => {
        let args = tc.args;
        if (args === undefined || args === null) {
            args = {};
        }
        const argsString = typeof args === "string" ? args : JSON.stringify(args);

        return {
            id: tc.toolCallId || `call_${i}`,
            name: tc.toolName,
            arguments: argsString,
        };
    });

    return {
        content: result.text,
        usage: {
            promptTokens: (result.usage as any)?.promptTokens || 0,
            completionTokens: (result.usage as any)?.completionTokens || 0,
            totalTokens: (result.usage as any)?.totalTokens || 0,
        },
        finishReason: result.finishReason,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    };
}

// Legacy compatibility alias
export const invoke = invokeChat;

// =============================================================================
// Image Generation
// =============================================================================

export async function invokeImage(
    modelId: string,
    prompt: string,
    options: ImageOptions = {}
): Promise<ImageResult> {
    const { provider } = getProvider(modelId);

    return withRetry(async () => {
        switch (provider) {
            case "google": {
                const googleBuffer = await googleGenerateImage(modelId, prompt, {
                    numberOfImages: options.n,
                });
                return { buffer: googleBuffer, mimeType: "image/png" };
            }

            case "openai": {
                const openaiBuffer = await openaiGenerateImage(modelId, prompt, {
                    size: options.size as any,
                    quality: options.quality as any,
                    n: options.n,
                });
                return { buffer: openaiBuffer, mimeType: "image/png" };
            }

            case "aiml": {
                const aimlApiKey = process.env.AI_ML_API_KEY;
                if (!aimlApiKey) {
                    throw new Error("AI_ML_API_KEY not configured");
                }
                console.log(`[aiml] Generating image with ${modelId}: "${prompt.slice(0, 50)}..."`);

                const aimlResponse = await fetch("https://api.aimlapi.com/v1/images/generations", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${aimlApiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        model: modelId,
                        prompt,
                        n: options.n || 1,
                        size: options.size || "1024x1024",
                    }),
                });

                if (!aimlResponse.ok) {
                    const errorText = await aimlResponse.text();
                    console.error(`[aiml] Image generation failed: ${aimlResponse.status}`, errorText);
                    throw new Error(`AIML image generation failed: ${aimlResponse.status} - ${errorText}`);
                }

                const aimlData = await aimlResponse.json() as { data: Array<{ b64_json?: string; url?: string }> };
                if (!aimlData.data || aimlData.data.length === 0) {
                    throw new Error("No image data returned from AIML");
                }

                const aimlImage = aimlData.data[0];
                if (aimlImage.b64_json) {
                    return { buffer: Buffer.from(aimlImage.b64_json, "base64"), mimeType: "image/png" };
                } else if (aimlImage.url) {
                    const imgResponse = await fetch(aimlImage.url);
                    const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());
                    return { buffer: imgBuffer, mimeType: "image/png" };
                }
                throw new Error("AIML returned no image data");
            }

            case "vertex": {
                const vertexResult = await generateVertexImage(modelId, prompt, {
                    size: options.size,
                    n: options.n,
                });
                return { buffer: vertexResult.buffer, mimeType: vertexResult.mimeType };
            }

            case "huggingface": {
                const imgCard = getModelById(modelId);
                const hfInput: HFInferenceInput = {
                    modelId: modelId,
                    task: "text-to-image",
                    prompt,
                    inferenceProvider: imgCard?.hfInferenceProvider,
                };
                const hfResult = await executeHFInference(hfInput);
                return { buffer: hfResult.data as Buffer, mimeType: "image/png" };
            }

            default:
                throw new Error(`Image generation not supported for provider: ${provider}. Model: ${modelId}`);
        }
    });
}

// =============================================================================
// Video Generation
// =============================================================================

export async function invokeVideo(
    modelId: string,
    prompt: string,
    options: VideoOptions = {}
): Promise<VideoResult> {
    const { provider } = getProvider(modelId);

    return withRetry(async () => {
        switch (provider) {
            case "google": {
                const googleResult = await googleGenerateVideo(modelId, prompt, {
                    duration: options.duration,
                    aspectRatio: options.aspectRatio as any,
                });
                return { buffer: googleResult.videoBuffer, mimeType: googleResult.mimeType };
            }

            case "openai": {
                const openaiResult = await openaiGenerateVideo(modelId, prompt, {
                    duration: options.duration,
                    resolution: options.resolution as any,
                    aspectRatio: options.aspectRatio as any,
                });
                return { buffer: openaiResult.videoBuffer, mimeType: openaiResult.mimeType };
            }

            case "aiml": {
                const aimlVideoApiKey = process.env.AI_ML_API_KEY;
                if (!aimlVideoApiKey) {
                    throw new Error("AI_ML_API_KEY not configured");
                }
                console.log(`[aiml] Generating video with ${modelId}: "${prompt.slice(0, 50)}..."`);

                const aimlVideoResponse = await fetch("https://api.aimlapi.com/v2/video/generations", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${aimlVideoApiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        model: modelId,
                        prompt,
                        aspect_ratio: options.aspectRatio || "16:9",
                        ...(options.duration && { duration: options.duration.toString() }),
                        ...(options.imageUrl && { image_url: options.imageUrl }),
                    }),
                });

                if (!aimlVideoResponse.ok) {
                    const errorText = await aimlVideoResponse.text();
                    console.error(`[aiml] Video generation failed: ${aimlVideoResponse.status}`, errorText);
                    throw new Error(`AIML video generation failed: ${aimlVideoResponse.status} - ${errorText}`);
                }

                const aimlVideoData = await aimlVideoResponse.json() as {
                    id?: string;
                    status?: string;
                    data?: { video?: { url?: string } };
                    video_url?: string;
                    url?: string;
                    video?: { url?: string };
                };
                console.log("[aiml] Video initial response:", JSON.stringify(aimlVideoData));

                if (aimlVideoData.id && aimlVideoData.status && !aimlVideoData.url && !aimlVideoData.video?.url && !aimlVideoData.video_url) {
                    console.log(`[aiml] Async job started: ${aimlVideoData.id}, status: ${aimlVideoData.status}`);
                    const jobId = aimlVideoData.id;
                    const maxAttempts = 40; // 40 × 15s = 10 minutes for long video generation
                    const pollIntervalMs = 15000; // 15 seconds between polls
                    let attempts = 0;

                    while (attempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
                        attempts++;

                        const pollResponse = await fetch(`https://api.aimlapi.com/v2/video/generations?generation_id=${jobId}`, {
                            method: "GET",
                            headers: {
                                "Authorization": `Bearer ${aimlVideoApiKey}`,
                            },
                        });

                        if (!pollResponse.ok) {
                            console.warn(`[aiml] Poll failed: ${pollResponse.status}`);
                            continue;
                        }

                        const pollData = await pollResponse.json() as {
                            status?: string;
                            video?: { url?: string };
                            video_url?: string;
                            url?: string;
                            error?: string;
                        };
                        console.log(`[aiml] Poll attempt ${attempts}: status=${pollData.status}`);

                        if (pollData.status === "completed" || pollData.status === "success") {
                            const finalUrl = pollData.video?.url || pollData.video_url || pollData.url;
                            if (finalUrl) {
                                console.log(`[aiml] Video ready: ${finalUrl}`);
                                const videoFetchResponse = await fetch(finalUrl);
                                const videoBuffer = Buffer.from(await videoFetchResponse.arrayBuffer());
                                return { buffer: videoBuffer, mimeType: "video/mp4" };
                            }
                        } else if (pollData.status === "failed" || pollData.error) {
                            throw new Error(`AIML video generation failed: ${pollData.error || "Unknown error"}`);
                        }
                    }
                    throw new Error("AIML video generation timed out after 5 minutes");
                }

                const videoUrl = aimlVideoData.video?.url || aimlVideoData.data?.video?.url || aimlVideoData.video_url || aimlVideoData.url;
                if (!videoUrl) {
                    console.log("[aiml] Video response (no URL found):", JSON.stringify(aimlVideoData));
                    throw new Error("AIML returned no video URL");
                }

                const videoResponse = await fetch(videoUrl);
                const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
                return { buffer: videoBuffer, mimeType: "video/mp4" };
            }

            case "vertex": {
                const vertexResult = await generateVertexVideo(modelId, prompt, {
                    duration: options.duration,
                    aspectRatio: options.aspectRatio,
                });
                return { buffer: vertexResult.buffer, mimeType: vertexResult.mimeType };
            }

            case "huggingface": {
                const videoCard = getModelById(modelId);
                const hfInput: HFInferenceInput = {
                    modelId: modelId,
                    task: "text-to-video",
                    prompt,
                    inferenceProvider: videoCard?.hfInferenceProvider,
                };
                const hfResult = await executeHFInference(hfInput);
                return { buffer: hfResult.data as Buffer, mimeType: "video/mp4" };
            }

            default:
                throw new Error(`Video generation not supported for provider: ${provider}. Model: ${modelId}`);
        }
    });
}

// =============================================================================
// Async Video Generation (Long-running jobs)
// =============================================================================

export async function submitVideoJob(
    modelId: string,
    prompt: string,
    options: VideoOptions = {}
): Promise<VideoJobResult> {
    const { provider } = getProvider(modelId);

    switch (provider) {
        case "aiml": {
            const apiKey = process.env.AI_ML_API_KEY;
            if (!apiKey) {
                throw new Error("AI_ML_API_KEY not configured");
            }

            console.log(`[aiml] Submitting video job for ${modelId}: "${prompt.slice(0, 50)}..."`);

            const response = await fetch("https://api.aimlapi.com/v2/video/generations", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: modelId,
                    prompt,
                    aspect_ratio: options.aspectRatio || "16:9",
                    ...(options.duration && { duration: options.duration.toString() }),
                    ...(options.imageUrl && { image_url: options.imageUrl }),
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`AIML video submission failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json() as { id?: string; status?: string };
            if (!data.id) {
                throw new Error("AIML returned no job ID");
            }

            console.log(`[aiml] Job submitted: ${data.id}, status: ${data.status}`);
            return {
                jobId: `aiml:${data.id}`,
                status: data.status === "queued" ? "queued" : "processing",
            };
        }

        case "openai": {
            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) {
                throw new Error("OPENAI_API_KEY not configured");
            }

            console.log(`[openai] Submitting video job for ${modelId}: "${prompt.slice(0, 50)}..."`);

            let size = "1280x720";
            if (options.aspectRatio === "9:16") size = "720x1280";
            else if (options.aspectRatio === "1:1") size = "1024x1792";

            const response = await fetch("https://api.openai.com/v1/videos", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: modelId.includes("sora") ? modelId : "sora-2",
                    prompt,
                    size,
                    seconds: String(options.duration && options.duration >= 8 ? (options.duration >= 12 ? 12 : 8) : 4),
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OpenAI video submission failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json() as { id?: string; status?: string };
            if (!data.id) {
                throw new Error("OpenAI returned no job ID");
            }

            console.log(`[openai] Job submitted: ${data.id}, status: ${data.status}`);
            return {
                jobId: `openai:${data.id}`,
                status: data.status === "queued" ? "queued" : "processing",
            };
        }

        case "google": {
            const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
            if (!apiKey) {
                throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not configured");
            }

            const genai = new GoogleGenAI({ apiKey });
            console.log(`[google] Submitting video job for ${modelId}: "${prompt.slice(0, 50)}..."`);

            const operation = await genai.videos.generate({
                model: modelId,
                prompt,
            });

            if (!operation.name) {
                throw new Error("Google returned no operation name");
            }

            console.log(`[google] Job submitted: ${operation.name}`);
            return {
                jobId: `google:${operation.name}`,
                status: "processing",
            };
        }

        case "vertex": {
            const apiKey = process.env.VERTEX_AI_API_KEY || process.env.GOOGLE_CLOUD_API_KEY;
            if (!apiKey) {
                throw new Error("VERTEX_AI_API_KEY or GOOGLE_CLOUD_API_KEY not configured");
            }

            const projectId = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
            if (!projectId) {
                throw new Error("VERTEX_PROJECT_ID or GOOGLE_CLOUD_PROJECT not configured");
            }

            const location = process.env.VERTEX_LOCATION || "us-central1";
            const normalizedModelId = modelId.includes("/") ? modelId.split("/").pop() : modelId;
            
            console.log(`[vertex] Submitting video job for ${modelId}: "${prompt.slice(0, 50)}..."`);

            const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${normalizedModelId}:predictLongRunning`;
            
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    instances: [{ prompt }],
                    parameters: {
                        aspectRatio: options.aspectRatio || "16:9",
                        durationSeconds: options.duration || 8,
                    },
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Vertex video submission failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json() as { name?: string };
            if (!data.name) {
                throw new Error("Vertex returned no operation name");
            }

            console.log(`[vertex] Job submitted: ${data.name}`);
            return {
                jobId: `vertex:${data.name}`,
                status: "processing",
            };
        }

        default:
            throw new Error(`Async video generation not supported for provider: ${provider}`);
    }
}

export async function checkVideoJobStatus(jobId: string): Promise<VideoJobStatus> {
    const [provider, id] = jobId.split(":");
    if (!provider || !id) {
        throw new Error(`Invalid job ID format: ${jobId}. Expected format: "provider:job_id"`);
    }

    switch (provider) {
        case "aiml": {
            const apiKey = process.env.AI_ML_API_KEY;
            if (!apiKey) {
                throw new Error("AI_ML_API_KEY not configured");
            }

            const response = await fetch(`https://api.aimlapi.com/v2/video/generations?generation_id=${id}`, {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                },
            });

            if (!response.ok) {
                throw new Error(`AIML video status check failed: ${response.status}`);
            }

            const data = await response.json() as {
                status?: string;
                video?: { url?: string };
                video_url?: string;
                url?: string;
                error?: string;
            };

            const status = data.status === "completed" || data.status === "success" ? "completed" :
                          data.status === "failed" ? "failed" :
                          data.status === "queued" ? "queued" : "processing";

            return {
                jobId,
                status,
                url: data.video?.url || data.video_url || data.url,
                error: data.error,
            };
        }

        case "openai": {
            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) {
                throw new Error("OPENAI_API_KEY not configured");
            }

            const response = await fetch(`https://api.openai.com/v1/videos/${id}`, {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                },
            });

            if (!response.ok) {
                throw new Error(`OpenAI video status check failed: ${response.status}`);
            }

            const data = await response.json() as {
                status?: string;
                video?: { url?: string };
                error?: string;
            };

            const status = data.status === "completed" || data.status === "success" ? "completed" :
                          data.status === "failed" ? "failed" :
                          data.status === "queued" ? "queued" : "processing";

            return {
                jobId,
                status,
                url: data.video?.url,
                error: data.error,
            };
        }

        case "google": {
            const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
            if (!apiKey) {
                throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not configured");
            }

            const genai = new GoogleGenAI({ apiKey });
            const operation = await genai.operations.get({ operationName: id });

            if (!operation.done) {
                return {
                    jobId,
                    status: "processing",
                };
            }

            if (operation.error) {
                return {
                    jobId,
                    status: "failed",
                    error: operation.error.message,
                };
            }

            const video = operation.response?.videos?.[0];
            return {
                jobId,
                status: "completed",
                url: video?.uri,
            };
        }

        case "vertex": {
            const apiKey = process.env.VERTEX_AI_API_KEY || process.env.GOOGLE_CLOUD_API_KEY;
            if (!apiKey) {
                throw new Error("VERTEX_AI_API_KEY or GOOGLE_CLOUD_API_KEY not configured");
            }

            const projectId = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
            const location = process.env.VERTEX_LOCATION || "us-central1";
            
            // Poll the operation endpoint
            const pollUrl = `https://${location}-aiplatform.googleapis.com/v1/${id}`;
            
            const response = await fetch(pollUrl, {
                headers: { "Authorization": `Bearer ${apiKey}` },
            });

            if (!response.ok) {
                throw new Error(`Vertex video status check failed: ${response.status}`);
            }

            const operation = await response.json() as {
                done?: boolean;
                error?: { message: string };
                response?: { predictions?: Array<{ bytesBase64Encoded?: string }> };
            };

            if (!operation.done) {
                return {
                    jobId,
                    status: "processing",
                };
            }

            if (operation.error) {
                return {
                    jobId,
                    status: "failed",
                    error: operation.error.message,
                };
            }

            // Video is complete - return a data URL since Vertex doesn't provide a direct URL
            const videoBase64 = operation.response?.predictions?.[0]?.bytesBase64Encoded;
            if (videoBase64) {
                return {
                    jobId,
                    status: "completed",
                    url: `data:video/mp4;base64,${videoBase64}`,
                };
            }

            return {
                jobId,
                status: "completed",
            };
        }

        default:
            throw new Error(`Video status checking not supported for provider: ${provider}`);
    }
}

// =============================================================================
// Text-to-Speech (TTS)
// =============================================================================

export async function invokeTTS(
    modelId: string,
    text: string,
    options: TTSOptions = {}
): Promise<Buffer> {
    const { provider } = getProvider(modelId);

    return withRetry(async () => {
        switch (provider) {
            case "google": {
                return googleGenerateSpeech(modelId, text, {
                    voice: options.voice,
                });
            }

            case "openai": {
                return openaiGenerateSpeech(modelId, text, {
                    voice: options.voice as any,
                    speed: options.speed,
                    responseFormat: options.responseFormat as any,
                });
            }

            case "vertex": {
                const vertexResult = await generateVertexSpeech(modelId, text, {
                    voice: options.voice,
                    language: options.language,
                });
                return vertexResult.buffer;
            }

            case "huggingface": {
                const ttsCard = getModelById(modelId);
                const hfInput: HFInferenceInput = {
                    modelId: modelId,
                    task: "text-to-speech",
                    prompt: text,
                    inferenceProvider: ttsCard?.hfInferenceProvider,
                };
                const hfResult = await executeHFInference(hfInput);
                return hfResult.data as Buffer;
            }

            default:
                throw new Error(`Text-to-Speech not supported for provider: ${provider}. Model: ${modelId}`);
        }
    });
}

// =============================================================================
// Speech-to-Text (ASR)
// =============================================================================

export async function invokeASR(
    modelId: string,
    audio: Buffer,
    options: ASROptions = {}
): Promise<ASRResult> {
    const { provider } = getProvider(modelId);

    return withRetry(async () => {
        switch (provider) {
            case "openai": {
                const openaiResult = await openaiTranscribeAudio(modelId, audio, {
                    language: options.language,
                    responseFormat: options.responseFormat as any,
                });
                return { text: openaiResult.text };
            }

            case "vertex": {
                const vertexResult = await transcribeVertexAudio(modelId, audio, {
                    language: options.language,
                });
                return { text: vertexResult.text };
            }

            case "huggingface": {
                const asrCard = getModelById(modelId);
                const hfInput: HFInferenceInput = {
                    modelId: modelId,
                    task: "automatic-speech-recognition",
                    audio: audio.toString("base64"),
                    inferenceProvider: asrCard?.hfInferenceProvider,
                };
                const hfASRResult = await executeHFInference(hfInput);
                if (hfASRResult.type === "text" && typeof hfASRResult.data === "string") {
                    return { text: hfASRResult.data };
                }
                return { text: "" };
            }

            case "google":
                throw new Error(`Google ASR not supported. Use Vertex Chirp or OpenAI Whisper. Model: ${modelId}`);

            default:
                throw new Error(`ASR not supported for provider: ${provider}. Model: ${modelId}`);
        }
    });
}

// =============================================================================
// Embeddings
// =============================================================================

export async function invokeEmbedding(
    modelId: string,
    input: string | string[],
    options: EmbeddingOptions = {}
): Promise<EmbeddingResult> {
    const { provider } = getProvider(modelId);
    const inputs = Array.isArray(input) ? input : [input];

    return withRetry(async () => {
        switch (provider) {
            case "google": {
                const embeddingModel = google.textEmbeddingModel(modelId);
                const result = await embedMany({
                    model: embeddingModel,
                    values: inputs,
                });

                return {
                    embeddings: result.embeddings,
                    usage: {
                        promptTokens: (result.usage as any)?.tokens || inputs.join("").length / 4,
                        totalTokens: (result.usage as any)?.tokens || inputs.join("").length / 4,
                    },
                };
            }

            case "huggingface": {
                const embCard = getModelById(modelId);
                const hfInput: HFInferenceInput = {
                    modelId: modelId,
                    task: "feature-extraction",
                    text: inputs.join(" "),
                    inferenceProvider: embCard?.hfInferenceProvider,
                };
                const hfResult = await executeHFInference(hfInput);
                const embData = hfResult.data as number[] | number[][];
                const embeddings = Array.isArray(embData[0])
                    ? (embData as number[][])
                    : [embData as number[]];

                return {
                    embeddings,
                    usage: {
                        promptTokens: inputs.join("").length / 4,
                        totalTokens: inputs.join("").length / 4,
                    },
                };
            }

            case "vertex": {
                const vertexResult = await generateVertexEmbeddings(modelId, inputs);
                return {
                    embeddings: vertexResult.embeddings,
                    usage: {
                        promptTokens: inputs.join("").length / 4,
                        totalTokens: inputs.join("").length / 4,
                    },
                };
            }

            case "openai": {
                const embeddingModel = openai.embedding(modelId);
                const result = await embedMany({
                    model: embeddingModel,
                    values: inputs,
                });

                return {
                    embeddings: result.embeddings,
                    usage: {
                        promptTokens: (result.usage as any)?.tokens || inputs.join("").length / 4,
                        totalTokens: (result.usage as any)?.tokens || inputs.join("").length / 4,
                    },
                };
            }

            default:
                throw new Error(`Embeddings not supported for provider: ${provider}. Model: ${modelId}`);
        }
    });
}
