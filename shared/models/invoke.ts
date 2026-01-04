/**
 * Central Invocation Layer
 * 
 * Single source of truth for ALL provider invocations across ALL modalities.
 * Routes to correct provider based on modelCard.provider.
 * 
 * This module is the ONLY place where provider-specific functions are called.
 * All API handlers (openai/endpoints.ts) use this module.
 */

import { getModelById, getLanguageModel } from "./registry.js";
import type { ModelCard, ModelProvider } from "./types.js";

// Provider-specific imports
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

// AI SDK imports
import { streamText, generateText, embedMany } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";


// =============================================================================
// Types
// =============================================================================

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
}

export interface ChatOptions {
    stream?: boolean;
    maxTokens?: number;
    temperature?: number;
    onToken?: (token: string) => void;
    onComplete?: (result: { usage: TokenUsage }) => void;
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
}

export interface ImageOptions {
    size?: string;
    quality?: string;
    n?: number;
}

export interface ImageResult {
    buffer: Buffer;
    mimeType: string;
}

export interface VideoOptions {
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
}

export interface VideoResult {
    buffer: Buffer;
    mimeType: string;
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
// Helper: Get Provider from Model
// =============================================================================

function getProvider(modelId: string): { provider: ModelProvider; card: ModelCard | null } {
    const card = getModelById(modelId);
    if (card) {
        return { provider: card.provider, card };
    }

    // Fallback: infer from model ID patterns
    if (modelId.startsWith("gemini") || modelId.startsWith("veo") || modelId.includes("google")) {
        return { provider: "google", card: null };
    }
    if (modelId.startsWith("gpt") || modelId.startsWith("dall-e") || modelId.startsWith("tts") ||
        modelId.startsWith("whisper") || modelId.startsWith("text-embedding") || modelId.startsWith("sora")) {
        return { provider: "openai", card: null };
    }
    if (modelId.startsWith("claude")) {
        return { provider: "anthropic", card: null };
    }
    if (modelId.includes("/")) {
        return { provider: "huggingface", card: null };
    }

    return { provider: "openai", card: null }; // Default fallback
}

// =============================================================================
// Chat/Text Generation
// =============================================================================

/**
 * Invoke chat/text generation for any provider
 */
export async function invokeChat(
    modelId: string,
    messages: ChatMessage[],
    options: ChatOptions = {}
): Promise<ChatResult | void> {
    const modelInstance = getLanguageModel(modelId);

    const mappedMessages = messages.map(m => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
    }));

    if (options.stream) {
        const result = streamText({
            model: modelInstance,
            messages: mappedMessages,
        });

        for await (const chunk of result.textStream) {
            if (options.onToken) options.onToken(chunk);
        }

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
    });

    return {
        content: result.text,
        usage: {
            promptTokens: (result.usage as any)?.promptTokens || 0,
            completionTokens: (result.usage as any)?.completionTokens || 0,
            totalTokens: (result.usage as any)?.totalTokens || 0,
        },
        finishReason: result.finishReason,
    };
}

// =============================================================================
// Image Generation
// =============================================================================

/**
 * Invoke image generation for any provider
 */
export async function invokeImage(
    modelId: string,
    prompt: string,
    options: ImageOptions = {}
): Promise<ImageResult> {
    const { provider } = getProvider(modelId);

    switch (provider) {
        case "google":
            const googleBuffer = await googleGenerateImage(modelId, prompt, {
                numberOfImages: options.n,
            });
            return { buffer: googleBuffer, mimeType: "image/png" };

        case "openai":
            const openaiBuffer = await openaiGenerateImage(modelId, prompt, {
                size: options.size as any,
                quality: options.quality as any,
                n: options.n,
            });
            return { buffer: openaiBuffer, mimeType: "image/png" };

        case "huggingface":
        default:
            const hfInput: HFInferenceInput = {
                modelId: modelId,
                task: "text-to-image",
                prompt,
            };
            const hfResult = await executeHFInference(hfInput);
            return { buffer: hfResult.data as Buffer, mimeType: "image/png" };
    }
}

// =============================================================================
// Video Generation
// =============================================================================

/**
 * Invoke video generation for any provider
 */
export async function invokeVideo(
    modelId: string,
    prompt: string,
    options: VideoOptions = {}
): Promise<VideoResult> {
    const { provider } = getProvider(modelId);

    switch (provider) {
        case "google":
            const googleResult = await googleGenerateVideo(modelId, prompt, {
                duration: options.duration,
                aspectRatio: options.aspectRatio as any,
            });
            return { buffer: googleResult.videoBuffer, mimeType: googleResult.mimeType };

        case "openai":
            const openaiResult = await openaiGenerateVideo(modelId, prompt, {
                duration: options.duration,
                resolution: options.resolution as any,
                aspectRatio: options.aspectRatio as any,
            });
            return { buffer: openaiResult.videoBuffer, mimeType: openaiResult.mimeType };

        case "huggingface":
        default:
            const hfInput: HFInferenceInput = {
                modelId: modelId,
                task: "text-to-video",
                prompt,
            };
            const hfResult = await executeHFInference(hfInput);
            return { buffer: hfResult.data as Buffer, mimeType: "video/mp4" };
    }
}

// =============================================================================
// Text-to-Speech
// =============================================================================

/**
 * Invoke TTS for any provider
 */
export async function invokeTTS(
    modelId: string,
    text: string,
    options: TTSOptions = {}
): Promise<Buffer> {
    const { provider } = getProvider(modelId);

    switch (provider) {
        case "google":
            return googleGenerateSpeech(modelId, text, {
                voice: options.voice,
            });

        case "openai":
            return openaiGenerateSpeech(modelId, text, {
                voice: options.voice as any,
                speed: options.speed,
                responseFormat: options.responseFormat as any,
            });

        case "huggingface":
        default:
            const hfInput: HFInferenceInput = {
                modelId: modelId,
                task: "text-to-speech",
                prompt: text,
            };
            const hfResult = await executeHFInference(hfInput);
            return hfResult.data as Buffer;
    }
}

// =============================================================================
// Speech-to-Text (ASR)
// =============================================================================

/**
 * Invoke ASR/transcription for any provider
 */
export async function invokeASR(
    modelId: string,
    audio: Buffer,
    options: ASROptions = {}
): Promise<ASRResult> {
    const { provider } = getProvider(modelId);

    switch (provider) {
        case "google":
            // Google doesn't have a direct transcribeAudio export - use HF fallback
            // or implement via Google Cloud Speech API if needed
            console.warn("[invoke] Google ASR not implemented, falling back to OpenAI");
        // Fallthrough to OpenAI

        case "openai":
            const openaiResult = await openaiTranscribeAudio(modelId, audio, {
                language: options.language,
                responseFormat: options.responseFormat as any,
            });
            return { text: openaiResult.text };

        case "huggingface":
        default:
            const hfInput: HFInferenceInput = {
                modelId: modelId,
                task: "automatic-speech-recognition",
                audio: audio.toString("base64"),
            };
            const hfASRResult = await executeHFInference(hfInput);
            // HFInferenceResult doesn't have text, check result type
            if (hfASRResult.type === "text" && typeof hfASRResult.data === "string") {
                return { text: hfASRResult.data };
            }
            return { text: "" };
    }
}

// =============================================================================
// Embeddings
// =============================================================================

/**
 * Invoke embeddings for any provider
 */
export async function invokeEmbedding(
    modelId: string,
    input: string | string[],
    options: EmbeddingOptions = {}
): Promise<EmbeddingResult> {
    const { provider } = getProvider(modelId);
    const inputs = Array.isArray(input) ? input : [input];

    let embeddingModel;
    switch (provider) {
        case "google":
            embeddingModel = google.textEmbeddingModel(modelId);
            break;
        case "openai":
        default:
            embeddingModel = openai.embedding(modelId);
            break;
    }

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
